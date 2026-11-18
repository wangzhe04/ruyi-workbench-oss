'use strict';
// Research-only, same original q8 weights/head with one extra hidden output.
// No check/acceptance selection, downloads, Python packages or production edits.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { pathToFileURL } = require('node:url'), { performance } = require('node:perf_hooks');
const fixturePath = path.join(__dirname, 'calibration-fixture.cjs'), fixture = require(fixturePath);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex'), read = file => JSON.parse(fs.readFileSync(file));
const root = path.resolve('output/semantic-reranker-research-v1'), runtime = path.resolve('output/semantic-runtime-win32-x64');
const exportReceiptPath = path.resolve('output/semantic-mmarco-dual-output-v1/export-receipt.json'), exported = read(exportReceiptPath);
const modes = ['cls', 'mean'], languageGroups = ['zh-zh', 'zh-en', 'en-zh', 'en-en'];
const output = path.resolve(process.argv[3] || 'output/semantic-mmarco-dual-plan-v1.json');
if (fs.existsSync(output)) throw Error('Use a new immutable output.');
function plan() {
  const queries = fixture.queries.filter(x => x.split === 'train' && x.kind === 'positive' && languageGroups.includes(x.group)).slice(0, 12);
  const pairs = queries.flatMap(query => {
    const relevantIndex = fixture.documents.findIndex(d => query.relevant.includes(d.id));
    return [relevantIndex, (relevantIndex + 1) % fixture.documents.length, (relevantIndex + 17) % fixture.documents.length].map(index => {
      const document = fixture.documents[index];
      return { queryId: query.id, documentId: document.id, querySha256: hash(query.text), documentSha256: hash(document.text) };
    });
  });
  return { schemaVersion: 1, fixtureSha256: hash(fs.readFileSync(fixturePath)), exportReceiptSha256: hash(fs.readFileSync(exportReceiptPath)),
    originalGraphSha256: exported.original.sha256, hiddenGraphSha256: exported.exported.sha256,
    pairSelection: 'First twelve train positive queries in the four language directions, each with relevant document and fixed +1/+17 corpus offsets; equivalence only, no fitting.',
    pairs, pairsSha256: hash(JSON.stringify(pairs)), encoding: { documents: fixture.documents.length,
      queries: fixture.queries.filter(x => ['train', 'calibration'].includes(x.split)).length, physicalBatch: 1, maxTokens: 512, prefix: '', pooling: modes,
      mean: 'Mean of final hidden states whose attention mask is nonzero, including native special tokens; then L2.', cls: 'First final hidden state (native XLM-R start token); then L2.' } };
}
function feed(session, input, ort) {
  if (input.input_ids.dims[0] !== 1) throw Error('Physical batch must remain one.');
  return Object.fromEntries(session.inputNames.map(name => {
    const tensor = input[name]; if (!tensor) throw Error('Unknown required graph input.');
    return [name, new ort.Tensor(tensor.type, tensor.data, tensor.dims)];
  }));
}
function normalized(values) {
  const norm = Math.hypot(...values);
  if (!Number.isFinite(norm) || norm <= 1e-12) throw Error('Invalid hidden vector norm.');
  return values.map(x => x / norm);
}
function pools(hidden, mask) {
  if (hidden.type !== 'float32' || hidden.dims.length !== 3 || hidden.dims[0] !== 1 || hidden.dims[2] !== 384
    || hidden.dims[1] !== mask.data.length) throw Error('Unexpected hidden tensor shape.');
  const mean = Array(384).fill(0); let count = 0;
  for (let token = 0; token < hidden.dims[1]; token++) if (Number(mask.data[token])) {
    count++; for (let dim = 0; dim < 384; dim++) mean[dim] += hidden.data[token * 384 + dim];
  }
  if (!count) throw Error('Empty attention mask.');
  return { cls: normalized(Array.from(hidden.data.slice(0, 384))), mean: normalized(mean.map(x => x / count)) };
}
function metrics(report) {
  const queries = fixture.queries.filter(q => ['train', 'calibration'].includes(q.split) && q.kind === 'positive' && languageGroups.includes(q.group));
  return Object.fromEntries(modes.map(mode => {
    const dv = new Map(report.documents.map(x => [x.id, x[mode]])), qv = new Map(report.queries.map(x => [x.id, x[mode]]));
    const rows = queries.map(query => {
      const q = qv.get(query.id), ranking = fixture.documents.map((doc, index) => ({ id: doc.id, index, score: q.reduce((s, v, i) => s + v * dv.get(doc.id)[i], 0) }))
        .sort((a, b) => b.score - a.score || a.index - b.index);
      return { id: query.id, split: query.split, group: query.group, rank: ranking.findIndex(x => query.relevant.includes(x.id)) + 1 };
    });
    const groupMetrics = values => ({ count: values.length, recall: Object.fromEntries([1, 5, 10, 20].map(k => [k, values.filter(x => x.rank > 0 && x.rank <= k).length / values.length])) });
    const splits = Object.fromEntries(['train', 'calibration', 'combined'].map(split => [split, Object.fromEntries(languageGroups.map(group => [group,
      groupMetrics(rows.filter(x => x.group === group && (split === 'combined' || x.split === split)))]))]));
    const viableAt20 = ['train', 'calibration'].every(split => splits[split]['zh-zh'].recall[20] >= .90
      && splits[split]['zh-en'].recall[20] >= .85 && splits[split]['en-zh'].recall[20] >= .85);
    return [mode, { splits, viableAt20, rows }];
  }));
}
async function collect() {
  const planPath = path.resolve(process.argv[4]), frozen = read(planPath);
  if (JSON.stringify(frozen) !== JSON.stringify(plan())) throw Error('Frozen development plan changed.');
  const { sha256: fileHash, verifyRuntimeAssets } = require('../../ruyi-workbench/semantic-runtime/verify.cjs');
  const manifest = read(path.join(root, 'research.lock.json'));
  for (const file of manifest.files) if (fs.statSync(path.join(root, file.path)).size !== file.bytes || await fileHash(path.join(root, file.path)) !== file.sha256) throw Error('Original MMARCO integrity failure.');
  if (await fileHash(exported.exported.file) !== frozen.hiddenGraphSha256 || await fileHash(exported.original.file) !== frozen.originalGraphSha256) throw Error('Export graph integrity failure.');
  await verifyRuntimeAssets(runtime);
  const deny = () => { throw Error('NETWORK_DISABLED'); }; globalThis.fetch = deny;
  for (const name of ['node:http', 'node:https']) { const module = require(name); module.get = deny; module.request = deny; }
  const net = require('node:net'); net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny; require('node:tls').connect = deny;
  const { AutoTokenizer, env } = await import(pathToFileURL(path.join(runtime, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs')));
  env.allowRemoteModels = false; env.allowLocalModels = true; env.useFSCache = false;
  const tokenizer = await AutoTokenizer.from_pretrained(root, { local_files_only: true }), ort = require(path.join(runtime, 'node_modules/onnxruntime-node'));
  const opts = { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1, logSeverityLevel: 4 };
  const queryMap = new Map(fixture.queries.filter(x => ['train', 'calibration'].includes(x.split)).map(x => [x.id, x])), docMap = new Map(fixture.documents.map(x => [x.id, x]));
  const inputs = frozen.pairs.map(pair => tokenizer([queryMap.get(pair.queryId).text], { text_pair: [docMap.get(pair.documentId).text], padding: true }));
  if (inputs.some(x => x.input_ids.dims[1] > 256)) throw Error('Pair truncation refused.');
  const report = { schemaVersion: 1, status: 'RUNNING', generatedAt: new Date().toISOString(), fixtureSha256: frozen.fixtureSha256,
    sources: [__filename, planPath, exportReceiptPath].map(file => ({ file, sha256: hash(fs.readFileSync(file)) })), plan: frozen,
    timingConditions: 'Development run only; no controlled end-to-end latency, combined-residency or 500ms claim.', documents: [], queries: [], pairChecks: {},
    limits: ['One original q8 weight inventory; classifier and all original nodes/initializers remain.', 'CLS and masked-mean/L2 are research representations without a trained bi-encoder contract.', 'No check/acceptance query is encoded or evaluated; no fitting or threshold grid.', 'Raw all-60-document ranks, without lexical/ID help, are the coarse-retrieval feasibility gate.'] };
  let session;
  try {
    for (const [name, graph] of [['original', exported.original.file], ['hidden', exported.exported.file]]) {
      session = await ort.InferenceSession.create(graph, opts); const scores = [], pairMs = [];
      for (const input of inputs) {
        const begin = performance.now(), result = await session.run(feed(session, input, ort)); pairMs.push(performance.now() - begin);
        if (result.logits.data.length !== 1 || !Number.isFinite(result.logits.data[0])) throw Error('Invalid original classifier logit.');
        scores.push(Number(result.logits.data[0]));
      }
      report.pairChecks[name] = { scores, pairMs, outputs: session.outputNames };
      if (name === 'original') { await session.release(); session = null; }
    }
    const differences = report.pairChecks.original.scores.map((x, i) => Math.abs(x - report.pairChecks.hidden.scores[i]));
    report.logitEquivalence = { pairs: differences.length, maxAbsoluteDifference: Math.max(...differences), exactlyEqual: differences.every(x => x === 0) };
    if (!report.logitEquivalence.exactlyEqual) throw Error('Original logits changed; stop before coarse encoding.');
    const plans = [...fixture.documents.map(x => ({ ...x, role: 'document' })), ...fixture.queries.filter(x => ['train', 'calibration'].includes(x.split)).map(x => ({ ...x, role: 'query' }))];
    for (const item of plans) {
      const input = tokenizer([item.text], { padding: true });
      if (input.input_ids.dims[1] > 512) throw Error('Single-text truncation refused.');
      const begin = performance.now(), result = await session.run(feed(session, input, ort));
      const vectors = pools(result[exported.recipe.outputName], input.attention_mask);
      report[item.role === 'document' ? 'documents' : 'queries'].push({ id: item.id, tokens: input.input_ids.dims[1], elapsedMs: performance.now() - begin, ...vectors });
    }
    report.retrieval = metrics(report);
    report.status = modes.some(mode => report.retrieval[mode].viableAt20) ? 'RAW_COARSE_RETRIEVAL_CANDIDATE_ONLY' : 'RED_RAW_RECALL_AT20';
  } catch (error) { report.status = 'FAIL'; report.error = String(error.stack || error); process.exitCode = 1; }
  finally { if (session) await session.release(); report.peakRssBytes = process.resourceUsage().maxRSS * 1024;
    report.finishedAt = new Date().toISOString(); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
  console.log(JSON.stringify({ output, status: report.status, logitEquivalence: report.logitEquivalence,
    retrieval: report.retrieval && Object.fromEntries(modes.map(mode => [mode, { viableAt20: report.retrieval[mode].viableAt20, splits: report.retrieval[mode].splits }])), peakRssBytes: report.peakRssBytes, error: report.error }));
}
if (process.argv[2] === 'plan') { const frozen = plan(); fs.writeFileSync(output, JSON.stringify(frozen, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ output, pairs: frozen.pairs.length, pairsSha256: frozen.pairsSha256, encoding: frozen.encoding })); }
else if (process.argv[2] === 'collect') collect().catch(error => { console.error(error); process.exitCode = 1; });
else throw Error('Use plan <new-output> or collect <new-report> <frozen-plan>.');
