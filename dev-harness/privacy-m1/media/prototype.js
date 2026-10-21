'use strict';
// Isolated synthetic-media feasibility prototype, deliberately outside production routes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const vm = require('node:vm');
const http = require('node:http');
const { killOwnTree } = require('../../lib/kill-own-tree');
const ROOT = path.resolve(__dirname, '../../..');
const WORKER = path.join(__dirname, 'worker.py');
const PYTHON = path.join(ROOT, 'mcp/ai-computer-control/build_offline/python_embed/python.exe');
const POLICY = Object.freeze({ version: 'm1-fixture-policy-1', personal: true,
  rules: Object.freeze([Object.freeze({ id: 'm1-private-phrase', kind: 'literal', value: 'ALPHA BRAVO CHARLIE', category: 'INTERNAL' })]) });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const failure = code => Object.assign(new Error(code), { code });
const detectorBindings = new WeakMap();
const ruleNames = ['01i-privacy-rules.js', '01h-privacy-core.js'];
const readRuleSource = () => ruleNames.map(name => fs.readFileSync(path.join(ROOT, 'ruyi-workbench/app/src', name), 'utf8')).join('\n');
const currentIdentity = (policy = POLICY) => ({ policyHash: sha(JSON.stringify(policy)), rulesHash: sha(readRuleSource()),
  processorHash: sha(fs.readFileSync(WORKER)), orchestrationHash: sha(fs.readFileSync(__filename)) });

function loadDetector(policy = POLICY, { policyRevision = 1 } = {}) {
  const source = readRuleSource();
  const core = vm.runInNewContext(source + '\nPrivacyCore;', { require, Buffer });
  const detector = core.createDetector(policy), identity = { ...currentIdentity(policy), rulesHash: sha(source) };
  detectorBindings.set(detector, { identity, policy, policyRevision });
  return { detector, ...identity };
}

// The owner is independent of any previously loaded detector/policy object. Replacing
// the current policy increments the authoritative revision even for identical rules.
function createPolicyOwner(initialPolicy = POLICY) {
  let policy = initialPolicy, revision = 1;
  return Object.freeze({
    getCurrentPolicyRevision: () => Object.freeze({ revision, policyHash: sha(JSON.stringify(policy)) }),
    loadDetector: () => loadDetector(policy, { policyRevision: revision }),
    replacePolicy: next => { policy = next; revision++; },
  });
}

function runWorker(request, { signal, timeout = 30000, python = PYTHON } = {}) {
  if (signal?.aborted) return Promise.reject(failure('cancelled'));
  if (!fs.existsSync(python)) return Promise.reject(failure('missing-component'));
  return new Promise((resolve, reject) => {
    const child = cp.spawn(python, ['-I', '-B', '-X', 'utf8', WORKER], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stopped, settled = false;
    const stop = code => { if (settled || stopped) return; stopped = code; killOwnTree(child); };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (err, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      err ? reject(err) : resolve(value);
    };
    child.on('error', () => finish(failure(stopped || 'missing-component')));
    child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 1024 * 1024) stop('output-limit'); });
    child.stderr.on('data', () => {}); // No raw exception/path/recognized text in logs or evidence.
    child.on('close', () => {
      if (stopped) return finish(failure(stopped));
      try { const result = JSON.parse(output); result.ok ? finish(null, result) : finish(failure(result.code)); }
      catch { finish(failure('processor-failed')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

// Offsets are JS UTF-16 offsets, exactly the units used by PrivacyCore. Never match
// only a token's prefix or mask a single box for a multi-word sensitive interval.
function mapWords(words, detector, width, height) {
  let text = '', previousLine;
  const spans = words.map(word => {
    if (!word || typeof word.text !== 'string' || !Number.isInteger(word.line) || !Array.isArray(word.box)) throw failure('invalid-ocr');
    if (text) text += word.line === previousLine ? ' ' : '\n';
    const start = text.length; text += word.text; previousLine = word.line;
    return { ...word, start, end: text.length };
  });
  if (!text.trim()) throw failure('unrecognized');
  const hits = detector.detect(text);
  if (!hits.length) throw failure('unrecognized'); // Conservative M1 fixture policy, no original-media fallback.
  const selected = spans.filter(word => hits.some(hit => word.start < hit.end && word.end > hit.start));
  for (const hit of hits) {
    const covered = selected.filter(word => word.start < hit.end && word.end > hit.start);
    if (!covered.length || covered[0].start > hit.start || covered.at(-1).end < hit.end) throw failure('incomplete-coverage');
  }
  const boxes = selected.map(word => {
    if (word.box.length !== 4 || word.box.some(n => !Number.isFinite(n))) throw failure('invalid-ocr');
    const [x1, y1, x2, y2] = word.box;
    if (x1 < 0 || y1 < 0 || x1 >= x2 || y1 >= y2 || x2 > width || y2 > height) throw failure('invalid-ocr');
    return [Math.max(0, Math.floor(x1) - 4), Math.max(0, Math.floor(y1) - 4), Math.min(width, Math.ceil(x2) + 4), Math.min(height, Math.ceil(y2) + 4)];
  });
  return { boxes, hitCount: hits.length, categories: [...new Set(hits.map(h => h.category))],
    matchedWords: selected.length, crossWord: hits.some(hit => spans.filter(w => w.start < hit.end && w.end > hit.start).length >= 3) };
}

async function startReceiver({ respond = true, onCapture } = {}) {
  const captures = [], requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method });
    if (req.method !== 'POST' || req.url !== '/derived' || req.headers['content-type'] !== 'image/png') { res.writeHead(400); res.end(); return; }
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) req.destroy(); else chunks.push(chunk); });
    req.on('end', () => {
      captures.push({ bytes: Buffer.concat(chunks), headers: req.headers });
      onCapture?.();
      if (respond) { res.writeHead(204); res.end(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  // Closed over fixed loopback host; callers cannot substitute an external endpoint.
  const upload = (bytes, { signal, deadline, commitCheck } = {}) => new Promise((resolve, reject) => {
    let req, timer, committed = false, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) {
        req?.destroy();
        error.delivery = committed ? 'unknown' : 'not-sent';
        error.requestDestroyed = !!req?.destroyed;
        reject(error);
      } else resolve(value);
    };
    const abort = () => finish(failure('cancelled'));
    const check = () => {
      if (signal?.aborted) throw failure('cancelled');
      if (!Number.isFinite(deadline)) throw failure('upload-deadline-required');
      if (Date.now() >= deadline) throw failure('upload-timeout');
      if (typeof commitCheck !== 'function') throw failure('upload-commit-check-required');
      commitCheck();
    };
    try {
      // No ClientRequest/socket exists for cancellation or stale policy at entry.
      check();
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(failure('upload-timeout')), Math.max(1, deadline - Date.now()));
      req = http.request({ host: '127.0.0.1', port, path: '/derived', method: 'POST',
        headers: { 'content-type': 'image/png', 'content-length': bytes.length, 'x-media-name': 'derived.png' } }, res => {
        res.resume();
        res.on('error', () => finish(failure('upload-failed')));
        res.on('end', () => res.statusCode === 204 ? finish(null, { delivery: 'sent', acknowledged: true }) : finish(failure('upload-failed')));
      });
      req.on('error', () => finish(failure('upload-failed')));
      // This synchronous check and req.end form the submission boundary. Later
      // cancellation destroys this request but cannot retract already sent bytes.
      check(); committed = true; req.end(bytes);
    } catch (error) { finish(error); }
  });
  return { captures, requests, upload, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

async function processImage({ source, root, id, detector, upload, signal, deadline = Date.now() + 60000,
  getCurrentPolicyRevision, workerOptions, beforeUpload, expectedProcessorHash }) {
  const binding = detectorBindings.get(detector), identity = binding?.identity;
  const check = () => {
    if (signal?.aborted) throw failure('cancelled');
    if (!Number.isFinite(deadline) || Date.now() >= deadline) throw failure('timeout');
    if (!identity || JSON.stringify(currentIdentity(binding.policy)) !== JSON.stringify(identity)) throw failure('processor-or-policy-changed');
    if (typeof getCurrentPolicyRevision !== 'function') throw failure('policy-owner-required');
    const current = getCurrentPolicyRevision();
    if (!current || current.revision !== binding.policyRevision || current.policyHash !== identity.policyHash) throw failure('processor-or-policy-changed');
    if (expectedProcessorHash !== undefined && identity.processorHash !== expectedProcessorHash) throw failure('processor-or-policy-changed');
  };
  check();
  // Own a single immutable byte snapshot. Every stage checks its hash, and original
  // filename, metadata, bytes, or backup thumbnail is never an upload argument.
  const sourceBytes = fs.readFileSync(source), sourceHash = sha(sourceBytes);
  const snapshot = path.join(root, id + '-snapshot.png'), target = path.join(root, id + '-derived.png');
  fs.writeFileSync(snapshot, sourceBytes, { flag: 'wx' });
  const opts = () => ({ ...workerOptions, signal, timeout: Math.min(workerOptions?.timeout ?? 30000, Math.max(1, deadline - Date.now())) });
  const ocr = await runWorker({ mode: 'ocr', source: snapshot, sourceHash }, opts());
  check();
  const mapped = mapWords(ocr.words, detector, ocr.width, ocr.height);
  const result = await runWorker({ mode: 'redact', source: snapshot, sourceHash, target, boxes: mapped.boxes }, opts());
  check();
  const after = result.wordsAfter.map(w => w.text).join(' ');
  if (detector.detect(after).length || !after.includes('PUBLIC REPORT 2026') || !after.includes('Order count 42')) throw failure('verification-failed');
  const bytes = fs.readFileSync(target);
  if (sha(bytes) !== result.derivedHash || sha(fs.readFileSync(snapshot)) !== sourceHash) throw failure('source-changed');
  if (beforeUpload) await beforeUpload({ target, snapshot });
  check();
  // Revalidate after asynchronous cancellation/policy hook, then upload these owned bytes.
  if (sha(fs.readFileSync(target)) !== result.derivedHash || sha(fs.readFileSync(snapshot)) !== sourceHash
    || sha(fs.readFileSync(source)) !== sourceHash) throw failure('source-changed');
  const delivery = await upload(bytes, { signal, deadline, commitCheck: () => {
    check();
    if (sha(fs.readFileSync(target)) !== result.derivedHash || sha(fs.readFileSync(snapshot)) !== sourceHash
      || sha(fs.readFileSync(source)) !== sourceHash) throw failure('source-changed');
  } });
  return { ...identity, policyRevision: binding.policyRevision, sourceHash, derivedHash: result.derivedHash, sourceBytes: sourceBytes.length, derivedBytes: bytes.length,
    ...mapped, boxes: undefined, metadataStripped: result.metadataStripped, coveredPixelsBlack: result.coveredPixelsBlack,
    publicTitlePixelsIdentical: result.publicTitlePixelsIdentical, secondOcrPrivateAbsent: true, secondOcrPublicPreserved: true,
    delivery: delivery.delivery, acknowledged: delivery.acknowledged };
}

module.exports = { ROOT, WORKER, PYTHON, POLICY, sha, failure, loadDetector, createPolicyOwner, runWorker, mapWords, startReceiver, processImage };
