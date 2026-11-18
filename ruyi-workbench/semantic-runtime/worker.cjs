'use strict';
// Standalone process: server.js must never import the isolated third-party runtime.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { LIMITS, validateRequest } = require('./protocol.cjs');
const { verify } = require('./verify.cjs');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const failure = (requestId, code) => send({ requestId: typeof requestId === 'string' ? requestId : null, ok: false, error: { code } });
function denyNetwork() {
  const deny = () => { throw new Error('NETWORK_DISABLED'); };
  globalThis.fetch = deny;
  for (const name of ['node:http', 'node:https']) { const api = require(name); api.request = deny; api.get = deny; }
  const net = require('node:net'); net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny;
  const tls = require('node:tls'); tls.connect = deny;
}
function modelFeeds(ort, session, inputs) {
  const feeds = {};
  for (const name of session.inputNames) {
    let value = inputs[name];
    // Single-text XLM-R tokenizers omit segment IDs, while the BERT graph used
    // by multilingual E5 explicitly requires them. Every token is segment 0.
    if (!value && name === 'token_type_ids' && inputs.input_ids?.type === 'int64') {
      const ids = inputs.input_ids;
      value = { type: 'int64', data: new BigInt64Array(ids.data.length), dims: ids.dims };
    }
    if (!value) throw new Error('MODEL_INPUT_MISSING');
    feeds[name] = new ort.Tensor(value.type, value.data, value.dims);
  }
  return feeds;
}
async function main() {
  denyNetwork();
  const args = process.argv.slice(2);
  const rootAt = args.indexOf('--root'); const modelAt = args.indexOf('--model');
  if (rootAt < 0 || !args[rootAt + 1]) throw new Error('ROOT_REQUIRED');
  const root = path.resolve(args[rootAt + 1]);
  const verified = await verify(root, modelAt >= 0 ? args[modelAt + 1] : undefined);
  const { model, modelDir, modelFingerprint } = verified;
  const runtimeEntry = path.join(root, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs');
  const { env, AutoTokenizer } = await import(pathToFileURL(runtimeEntry).href);
  env.allowRemoteModels = false; env.allowLocalModels = true; env.useBrowserCache = false; env.useFSCache = false;
  // Prevent library progress/warning output from contaminating NDJSON or logging text.
  console.log = console.info = console.warn = console.error = () => {};
  const tokenizer = await AutoTokenizer.from_pretrained(modelDir, { local_files_only: true });
  const disableArena = process.env.RUYI_SEMANTIC_DISABLE_ARENA === '1';
  // Load the already hash-verified ONNX file natively. AutoModel loads another
  // full weight ArrayBuffer in JS; that copy is unnecessary for this text-only
  // encoder and materially increases both startup peak and resident memory.
  const ort = require(path.join(root, 'node_modules', 'onnxruntime-node'));
  const onnx = model.files.filter(file => file.path.endsWith('.onnx'));
  if (onnx.length !== 1) throw new Error('INVALID_MODEL_GRAPH');
  const session = await ort.InferenceSession.create(path.join(modelDir, onnx[0].path), { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1, logSeverityLevel: 4,
    ...(disableArena ? { enableCpuMemArena: false, enableMemPattern: false } : {}) });
  const encoder = async inputs => {
    return session.run(modelFeeds(ort, session, inputs));
  };
  encoder.dispose = () => session.release();
  const queue = []; const activeIds = new Set(); let running = false; let ended = false;
  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      const nextQuery = queue.findIndex(item => item.request.role === 'query');
      const task = queue.splice(nextQuery < 0 ? 0 : nextQuery, 1)[0];
      const { request, deadline } = task;
      if (Date.now() >= deadline) { failure(request.requestId, 'DEADLINE_EXCEEDED'); activeIds.delete(request.requestId); continue; }
      let replied = false;
      const timer = setTimeout(() => { replied = true; failure(request.requestId, 'DEADLINE_EXCEEDED'); }, Math.max(1, deadline - Date.now()));
      try {
        const texts = request.texts.map(text => model.prefix[request.role] + text);
        const tokenCounts = texts.map(text => tokenizer.encode(text).length);
        const vectors = []; const encodedTokenCounts = [];
        // Dynamic INT8 scales depend on the batch's padding and other texts.
        // Fixed physical batch=1 makes each cached text vector independent of
        // request composition/order while preserving the bounded NDJSON batch API.
        for (const text of texts) {
          if (replied || Date.now() >= deadline) break;
          const inputs = tokenizer([text], { padding: true, truncation: true, max_length: model.maxTokens });
          const output = await encoder(inputs);
          const hidden = output.last_hidden_state;
          if (!hidden || hidden.dims.length !== 3 || hidden.dims[0] !== 1 || hidden.dims[2] !== model.dimensions) throw new Error('INVALID_MODEL_OUTPUT');
          const [, tokens, dims] = hidden.dims; const values = hidden.data; const mask = inputs.attention_mask.data;
          const vector = new Array(dims).fill(0); let count = 0;
          for (let t = 0; t < (model.pooling === 'cls' ? 1 : tokens); t++) {
            if (model.pooling !== 'cls' && !Number(mask[t])) continue;
            count++;
            for (let d = 0; d < dims; d++) vector[d] += Number(values[t * dims + d]);
          }
          if (!count) throw new Error('INVALID_MODEL_OUTPUT');
          const norm = Math.sqrt(vector.reduce((n, v) => n + v * v, 0));
          if (!Number.isFinite(norm) || norm <= 0) throw new Error('INVALID_MODEL_OUTPUT');
          vectors.push(vector.map(v => v / norm));
          encodedTokenCounts.push(Array.from(mask).reduce((n, value) => n + Number(value), 0));
        }
        if (!replied) { replied = true; if (Date.now() >= deadline) failure(request.requestId, 'DEADLINE_EXCEEDED'); else send({ requestId: request.requestId, ok: true, vectors, dimensions: model.dimensions, modelFingerprint, tokenCounts, encodedTokenCounts, truncated: tokenCounts.map((count, i) => count > encodedTokenCounts[i]), metrics: { rssBytes: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 } }); }
      } catch { if (!replied) failure(request.requestId, 'ENCODE_FAILED'); }
      finally { clearTimeout(timer); activeIds.delete(request.requestId); }
    }
    running = false;
    if (ended) await encoder.dispose();
  }
  let buffer = Buffer.alloc(0); let oversized = false;
  function accept(line) {
    let request; try { request = JSON.parse(line); } catch { failure(null, 'INVALID_JSON'); return; }
    const error = validateRequest(request); if (error) { failure(request && request.requestId, error); return; }
    if (activeIds.has(request.requestId)) { failure(request.requestId, 'DUPLICATE_REQUEST_ID'); return; }
    if (queue.length >= LIMITS.maxQueue) { failure(request.requestId, 'QUEUE_FULL'); return; }
    const now = Date.now(); activeIds.add(request.requestId);
    queue.push({ request, deadline: Math.min(request.deadlineMs || now + LIMITS.defaultDeadlineMs, now + LIMITS.maxDeadlineMs) });
    void pump();
  }
  process.stdin.on('data', chunk => {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      const part = chunk.subarray(start, i); start = i + 1;
      if (!oversized && buffer.length + part.length <= LIMITS.maxLineBytes) accept(Buffer.concat([buffer, part]).toString('utf8'));
      else failure(null, 'LINE_LIMIT');
      buffer = Buffer.alloc(0); oversized = false;
    }
    if (!oversized) {
      const tail = chunk.subarray(start);
      if (buffer.length + tail.length > LIMITS.maxLineBytes) { buffer = Buffer.alloc(0); oversized = true; }
      else buffer = Buffer.concat([buffer, tail]);
    }
  });
  process.stdin.on('end', () => { ended = true; if (buffer.length || oversized) failure(null, 'INCOMPLETE_LINE'); if (!running) void encoder.dispose(); });
  send({ type: 'ready', ok: true, protocolVersion: 1, modelId: model.id, dimensions: model.dimensions, modelFingerprint, retrievalThresholds: model.retrievalThresholds, limits: { ...LIMITS, maxTokens: model.maxTokens, recommendedChunkChars: model.recommendedChunkChars } });
}
main().catch(() => { send({ type: 'ready', ok: false, error: { code: 'RUNTIME_UNAVAILABLE' } }); process.exitCode = 1; });
