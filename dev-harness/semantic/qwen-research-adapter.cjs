'use strict';
// Opt-in research only. Never reads a fixture, downloads an asset, or changes
// the production model registry. All model input comes from encode callers.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const cp = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { killOwnTree } = require('../lib/kill-own-tree.js');

const PREFIX = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:';
const CONTRACT = Object.freeze({ dimensions: 1024, pooling: 'last-unmasked-token', normalize: 'L2', queryPrefix: PREFIX,
  documentPrefix: '', physicalBatch: 1, maxTokens: 512, appendEos: true, gpuLayers: 0, threads: 2, threadsBatch: 2 });
const PIN = Object.freeze({
  lock: '2c28aa645cce67b5fb52fba20995e437bbf658a028ea04facbc695b18680ab6f',
  inventory: 'df28bbd092859a35efe46244e28d22087049b1a782de418c0fb219f526a1af03',
  collector: '854075f70275d584e0e387522bea2f6e1c91b91e4c2c411ca681933fd20e811b',
  graph: '23d234bb57a42528a22a13e7beb8b57d8844b2b9cc741b4c27a8ff132abf0dfd',
  archive: '14cf1303ca9ac3abd94816850532f9f9a69ac66fbaca3776fc6f9061c2fac1d1',
  reference: 'sha256:4145039138abb861752943e8df98b4d9324c23b32b430b0452b58f1d72924734',
});
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function failure(code) { const error = new Error(code); error.code = code; return error; }
function check(deadline, signal) {
  if (signal?.aborted) throw signal.reason || failure('CANCELLED');
  if (Date.now() >= deadline) throw failure('DEADLINE_EXCEEDED');
}
function validateVector(vector) {
  if (!Array.isArray(vector) || vector.length !== 1024 || !vector.every(Number.isFinite)
    || Math.abs(Math.hypot(...vector) - 1) > 1e-4) throw failure('INVALID_VECTOR');
  return vector;
}
async function digest(file, deadline, signal) {
  check(deadline, signal);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const stream = fs.createReadStream(file, { signal: combined }), value = crypto.createHash('sha256');
  try { for await (const chunk of stream) { check(deadline, signal); value.update(chunk); } return value.digest('hex'); }
  finally { clearTimeout(timer); stream.destroy(); }
}
function regular(file) { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw failure('INTEGRITY_FAILED'); return stat; }
function boundedDeadline(opts, defaultMs) {
  const budget = Number.isFinite(opts.budgetMs) ? Math.max(0, opts.budgetMs) : defaultMs;
  return Math.min(Number.isFinite(opts.deadline) ? opts.deadline : Infinity, Date.now() + budget);
}
function ownsListener(output, port, pid) {
  const rows = output.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(row => row[0] === 'TCP' && row[1] === '127.0.0.1:' + port && row[2] === '0.0.0.0:0');
  if (rows.some(row => Number(row.at(-1)) !== pid)) throw failure('LISTENER_IDENTITY_FAILED');
  return rows.some(row => Number(row.at(-1)) === pid);
}
async function verify(root, deadline, signal) {
  const lockFile = path.join(root, 'research.lock.json'), inventoryFile = path.join(root, 'runtime-inventory.json');
  regular(lockFile); regular(inventoryFile);
  if (await digest(lockFile, deadline, signal) !== PIN.lock || await digest(inventoryFile, deadline, signal) !== PIN.inventory)
    throw failure('INTEGRITY_FAILED');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')), inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
  for (const file of lock.files) {
    if (!/^[\w./-]+$/.test(file.path) || file.path.split('/').includes('..')) throw failure('INTEGRITY_FAILED');
    const target = path.join(root, file.path);
    if (regular(target).size !== file.bytes || await digest(target, deadline, signal) !== file.sha256) throw failure('INTEGRITY_FAILED');
  }
  const graph = lock.files.find(file => file.path === 'Qwen3-Embedding-0.6B-Q4_K_M.gguf');
  const archive = lock.files.find(file => file.path === 'llama-b11146-bin-win-cpu-x64.zip');
  if (graph?.sha256 !== PIN.graph || archive?.sha256 !== PIN.archive) throw failure('INTEGRITY_FAILED');
  const expected = new Set(inventory.files.map(file => file.path));
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw failure('INTEGRITY_FAILED');
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else if (!entry.isFile() || !expected.delete(relative)) throw failure('INTEGRITY_FAILED');
    }
  }
  walk(path.join(root, 'runtime')); if (expected.size) throw failure('INTEGRITY_FAILED');
  for (const file of inventory.files) {
    const target = path.join(root, 'runtime', file.path);
    if (regular(target).size !== file.bytes || await digest(target, deadline, signal) !== file.sha256) throw failure('INTEGRITY_FAILED');
  }
  if (await digest(path.join(root, 'collect.cjs'), deadline, signal) !== PIN.collector) throw failure('REFERENCE_CONTRACT_FAILED');
  const reference = 'sha256:' + hash(JSON.stringify([lock, PIN.inventory, CONTRACT, PIN.collector]));
  if (reference !== PIN.reference) throw failure('REFERENCE_CONTRACT_FAILED');
  return { lock, inventory, reference };
}
async function availablePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

function create(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '../../output/semantic-qwen3-q4-research-v1'));
  const startupMs = Math.min(20000, Math.max(100, Number(options.startupMs) || 20000));
  const implementationSha256 = hash(fs.readFileSync(__filename));
  let child = null, base = '', apiKey = '', ready = null, starting = null, startupController = null, startupError = null, active = false, stopping = null, closingCount = 0, generation = 0;
  const recentMs = { query: 150, document: 150 };
  let state = 'cold'; const owned = new WeakMap();
  const stats = { verifications: 0, starts: 0, tokenizeWrites: 0, embeddingWrites: 0, completedTexts: 0, kills: 0 };
  function estimateEncodingBudget(role, count) {
    if (!['query', 'document'].includes(role) || !Number.isInteger(count) || count < 1 || count > 16) throw failure('INVALID_BUDGET_REQUEST');
    // The host and native admission use this exact whole-batch estimate. No
    // text is inspected; keep room for the final source/authority callback.
    return Math.min(60000, Math.ceil(Math.max(150, recentMs[role] * 1.2) * count + 32));
  }
  const descriptor = () => ({ ok: !!ready && !!child, available: !!ready && !!child, state, ...(ready || {}),
    minimumScore: .44, searchThreshold: .44, retrievalThresholds: { search: .44, automatic: null },
    modelId: 'qwen3-embedding-0.6b-openmycel-q4km-research', dimensions: 1024, maxTokens: 512,
    adapterSha256: implementationSha256, referenceFingerprint: PIN.reference, researchOnly: true });

  async function terminate(target, reason) {
    if (!target) return;
    const record = owned.get(target); if (!record) throw failure('UNOWNED_PROCESS');
    const wasCurrent = child === target;
    if (!record.terminating) {
      closingCount++;
      record.terminating = (async () => {
        try {
          if (target.exitCode === null && target.signalCode === null) { stats.kills++; killOwnTree(target); }
          await record.closed; // Actual process/stdio close, never a timeout pretending to be exit.
        } finally { closingCount--; }
      })();
    }
    await record.terminating;
    if (wasCurrent && (!child || child === target)) { child = null; base = ''; apiKey = ''; ready = null; state = reason; }
  }
  async function stop(reason = 'stopped') {
    generation++; state = reason; ready = null; startupError = null;
    startupController?.abort(failure('STOPPED'));
    const target = child;
    stopping = terminate(target, reason); await stopping; stopping = null;
    // Abort also closes a verification stream; await its owner before returning.
    if (starting) await starting.catch(() => {});
    return { ok: true, state: reason, workerExited: !child };
  }
  function environment(home) {
    for (const name of ['AppData/Local', 'AppData/Roaming', 'ProgramData', 'Temp', 'cache']) fs.mkdirSync(path.join(home, name), { recursive: true });
    return { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC,
      PATH: path.join(root, 'runtime') + ';' + path.join(process.env.SystemRoot, 'System32'),
      USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
      PROGRAMDATA: path.join(home, 'ProgramData'), TEMP: path.join(home, 'Temp'), TMP: path.join(home, 'Temp'),
      HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', LLAMA_CACHE: path.join(home, 'cache'), LLAMA_ARG_OFFLINE: '1' };
  }
  async function launch(deadline, signal) {
    const epoch = generation; state = 'loading';
    stats.verifications++;
    const verified = await verify(root, deadline, signal); check(deadline, signal);
    if (epoch !== generation) throw failure('STOPPED');
    const port = await availablePort(); check(deadline, signal);
    if (epoch !== generation) throw failure('STOPPED');
    const home = fs.mkdtempSync(path.join(root, 'adapter-home-'));
    apiKey = crypto.randomBytes(32).toString('hex');
    const args = ['--model', path.join(root, 'Qwen3-Embedding-0.6B-Q4_K_M.gguf'), '--offline', '--embedding', '--pooling', 'last',
      '--embd-normalize', '2', '--n-gpu-layers', '0', '--ctx-size', '512', '--batch-size', '512', '--ubatch-size', '512',
      '--parallel', '1', '--threads', '2', '--threads-batch', '2', '--fit', 'off', '--no-webui', '--no-webui-mcp-proxy',
      '--no-cache-prompt', '--host', '127.0.0.1', '--port', String(port), '--api-key', apiKey];
    const target = cp.spawn(path.join(root, 'runtime/llama-server.exe'), args, { cwd: home, env: environment(home), windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'] });
    const closed = new Promise(resolve => target.once('close', () => {
      if (child === target) { child = null; base = ''; apiKey = ''; ready = null; state = 'unavailable'; }
      resolve();
    }));
    target.on('error', () => {}); owned.set(target, { closed }); child = target; base = 'http://127.0.0.1:' + port; stats.starts++;
    try {
      while (true) {
        check(deadline, signal); if (epoch !== generation) throw failure('STOPPED');
        if (target.exitCode !== null || target.signalCode !== null) throw failure('WORKER_EXITED');
        const observed = await promisify(cp.execFile)(path.join(process.env.SystemRoot, 'System32/netstat.exe'), ['-ano', '-p', 'TCP'],
          { windowsHide: true, encoding: 'utf8', timeout: Math.max(1, Math.min(1000, deadline - Date.now())), maxBuffer: 4 * 1024 * 1024, signal });
        check(deadline, signal);
        if (ownsListener(observed.stdout, port, target.pid)) {
          try { const response = await fetch(base + '/health', { headers: { Authorization: 'Bearer ' + apiKey },
            signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(250, deadline - Date.now()))), ...(signal ? [signal] : [])]) }); if (response.ok) break; }
          catch { check(deadline, signal); }
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      check(deadline, signal); if (epoch !== generation) throw failure('STOPPED');
      const modelFingerprint = 'sha256:' + hash(JSON.stringify([verified.reference, CONTRACT, implementationSha256, PIN.inventory]));
      ready = { modelFingerprint, contract: CONTRACT }; state = 'ready'; return descriptor();
    } catch (error) { await terminate(target, signal?.aborted ? 'cancelled' : 'unavailable'); throw error; }
  }
  async function prepare(opts = {}) {
    const deadline = Math.min(Date.now() + startupMs, boundedDeadline(opts, startupMs));
    checkSignal();
    function checkSignal() { if (opts.signal?.aborted) throw opts.signal.reason || failure('CANCELLED'); }
    if (Date.now() >= deadline) return { ...descriptor(), ok: false, available: false, state: 'timeout', reason: 'timeout', error: { code: 'DEADLINE_EXCEEDED' } };
    if (startupError) throw startupError;
    // One startup owner. A later caller never inherits its wait/deadline or kills it.
    if (starting || stopping || closingCount) return { ...descriptor(), ok: false, available: false, state: 'loading', reason: 'overloaded', error: { code: 'PREPARE_BUSY' } };
    if (ready && child) return descriptor();
    startupController = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, startupController.signal]) : startupController.signal;
    // A foreground search must not restart 443MB integrity verification on every
    // 1s deadline. Preparation has its own bounded owner and contains no user text.
    const background = deadline - Date.now() <= 1000;
    const startupDeadline = background ? Date.now() + startupMs : deadline;
    starting = (async () => {
      try { await launch(startupDeadline, signal); check(startupDeadline, signal); return descriptor(); }
      catch (error) {
        if (opts.signal?.aborted) { await terminate(child, 'cancelled'); state = 'cancelled'; throw opts.signal.reason || error; }
        if (Date.now() >= startupDeadline || error?.code === 'DEADLINE_EXCEEDED') {
          await terminate(child, 'timeout'); state = 'timeout'; return { ...descriptor(), ok: false, available: false, state: 'timeout', reason: 'timeout', error: { code: 'DEADLINE_EXCEEDED' } };
        }
        if (signal.aborted && signal.reason?.code === 'STOPPED') return { ...descriptor(), ok: false, available: false, state: 'stopped', reason: 'unavailable', error: { code: 'STOPPED' } };
        if (['WORKER_EXITED', 'STOPPED'].includes(error?.code)) return { ...descriptor(), ok: false, available: false, state: 'unavailable', reason: 'unavailable', error: { code: error.code } };
        state = 'unavailable'; if (background) startupError = error;
        throw error; // Integrity/reference/listener proof failures are hard failures.
      } finally { starting = null; startupController = null; }
    })();
    if (background) {
      starting.catch(() => {}); // Hard failures are retained and thrown by the next prepare.
      return { ...descriptor(), ok: false, available: false, state: 'loading', reason: 'unavailable' };
    }
    return starting;
  }
  async function encode(texts, opts = {}) {
    if (!Array.isArray(texts) || !texts.length || texts.length > 16 || texts.some(text => typeof text !== 'string' || !text.length || text.length > 4096)
      || !['query', 'document'].includes(opts.role)) return { ok: false, state: 'invalid', error: { code: 'INVALID_REQUEST' } };
    const deadline = boundedDeadline(opts, 1000);
    if (opts.signal?.aborted) throw opts.signal.reason || failure('CANCELLED');
    if (Date.now() >= deadline) return { ok: false, state: 'timeout', reason: 'timeout', completed: 0,
      completedVectors: [], error: { code: 'INSUFFICIENT_BUDGET' } };
    if (active) return { ok: false, state: 'busy', reason: 'overloaded', error: { code: 'BUSY' }, completed: 0, completedVectors: [] };
    active = true; const vectors = [], encodedTokens = [], epoch = generation; let guardError = null, wrote = false;
    const finish = (state, code) => ({ ok: vectors.length === texts.length, state,
      ...(vectors.length === texts.length ? { vectors } : { completedVectors: vectors }), encodedTokens, completed: vectors.length,
      total: texts.length, coverage: { complete: vectors.length === texts.length, encoded: vectors.length, total: texts.length },
      ...(ready || {}), ...(code ? { reason: ['INSUFFICIENT_BUDGET', 'DEADLINE_EXCEEDED'].includes(code) ? 'timeout' : 'unavailable', error: { code } } : {}) });
    async function guard() {
      check(deadline, opts.signal);
      if (opts.beforeEncode) { try { await opts.beforeEncode(); } catch (error) { guardError = { value: error }; throw error; } }
      check(deadline, opts.signal); if (epoch !== generation) throw failure('STOPPED');
    }
    async function request(endpoint, body, target) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
      const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
      try {
        check(deadline, opts.signal);
        if (target !== child || target.exitCode !== null || target.signalCode !== null) throw failure('WORKER_EXITED');
        wrote = true;
        const response = await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + apiKey }, body: JSON.stringify(body), signal });
        if (!response.ok) throw failure('NATIVE_HTTP_ERROR'); return await response.json();
      } catch (error) {
        const cancelled = opts.signal?.aborted, expired = controller.signal.aborted || Date.now() >= deadline;
        await terminate(target, cancelled ? 'cancelled' : expired ? 'timeout' : 'unavailable');
        if (cancelled) throw opts.signal.reason || error;
        throw failure(expired ? 'DEADLINE_EXCEEDED' : error?.code || 'NATIVE_HTTP_ERROR');
      } finally { clearTimeout(timer); }
    }
    try {
      await guard();
      const status = await prepare({ deadline, signal: opts.signal });
      if (!status.ok) return { ...finish(status.state, status.error?.code || 'MODEL_LOADING'), reason: status.reason };
      await guard();
      if (deadline - Date.now() < Math.max(Number(opts.minimumBudgetMs) || 0, estimateEncodingBudget(opts.role, texts.length)))
        return finish('timeout', 'INSUFFICIENT_BUDGET');
      for (const text of texts) {
        const minimum = estimateEncodingBudget(opts.role, 1);
        await guard(); if (deadline - Date.now() < minimum) return finish(vectors.length ? 'partial' : 'timeout', 'INSUFFICIENT_BUDGET');
        const target = child, content = (opts.role === 'query' ? PREFIX : '') + text, begin = Date.now();
        stats.tokenizeWrites++; const tokens = await request('/tokenize', { content, add_special: true, parse_special: false }, target);
        await guard();
        if (!Array.isArray(tokens.tokens) || tokens.tokens.length > 512 || tokens.tokens.at(-1) !== 151643)
          return finish('partial', 'INPUT_TRUNCATION_REFUSED');
        if (deadline - Date.now() < minimum) return finish(vectors.length ? 'partial' : 'timeout', 'INSUFFICIENT_BUDGET');
        stats.embeddingWrites++; const result = await request('/v1/embeddings', { input: content, encoding_format: 'float', cache_prompt: false }, target);
        await guard();
        const vector = validateVector(result.data?.[0]?.embedding);
        if (result.data.length !== 1 || result.usage?.prompt_tokens !== tokens.tokens.length) throw failure('TOKEN_CONTRACT_FAILED');
        vectors.push(vector); encodedTokens.push(tokens.tokens.length); stats.completedTexts++;
        recentMs[opts.role] = Math.max(Date.now() - begin, recentMs[opts.role] * .9);
      }
      return finish('ready');
    } catch (error) {
      if (guardError && guardError.value === error) { if (wrote) await terminate(child, 'guard-failed'); throw error; }
      if (opts.signal?.aborted) { await terminate(child, 'cancelled'); throw opts.signal.reason || error; }
      if (['DEADLINE_EXCEEDED', 'STOPPED'].includes(error?.code)) {
        if (error.code === 'DEADLINE_EXCEEDED' && wrote) await terminate(child, 'timeout');
        return finish(vectors.length ? 'partial' : 'timeout', error.code);
      }
      if (['INVALID_VECTOR', 'TOKEN_CONTRACT_FAILED', 'NATIVE_HTTP_ERROR', 'WORKER_EXITED'].includes(error?.code)) {
        await terminate(child, 'unavailable'); return finish('unavailable', error.code);
      }
      throw error; // Source/authority guards keep their original identity and are never swallowed.
    } finally { active = false; }
  }
  return { descriptor, prepare, encode, stop, estimateEncodingBudget, stats: () => ({ ...stats, recentMs: { ...recentMs }, state,
    processAlive: !!child && child.exitCode === null && child.signalCode === null, pid: child?.pid || null }) };
}
module.exports = { create, CONTRACT, PIN, validateVector, boundedDeadline, ownsListener };
