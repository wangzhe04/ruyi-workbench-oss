// Optional native embedding backend. No registration/default selection here.
const SemanticNativeClient = (function semanticNativeFactory() {
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const cp = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const os = require('node:os');
const process = require('node:process');
const liveChildren = new Set();
process.once('exit', () => { for (const target of liveChildren) { try { target.kill('SIGKILL'); } catch { /* OS already reaped it */ } } });

const PREFIX = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:';
const CONTRACT = Object.freeze({ dimensions: 1024, pooling: 'last-unmasked-token', normalize: 'L2', queryPrefix: PREFIX,
  documentPrefix: '', physicalBatch: 1, maxTokens: 512, appendEos: true, gpuLayers: 0, threads: 2, threadsBatch: 2 });
const PIN = Object.freeze({ lock: '2e47371f2bf6bce13ce23d0f182c7f31d492e2ef5d17ba43b1b64f3ba3b3a0f0' });
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
  try {
    if (!root) throw Object.assign(Error(), { code: 'ENOENT' });
    const lockFile = path.join(root, 'native.lock.json'); regular(lockFile);
    if (await digest(lockFile, deadline, signal) !== PIN.lock) throw failure('ASSET_INTEGRITY_FAILED');
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (lock.backend !== 'llama.cpp-cpu' || lock.profile !== 'qwen3-embedding-0.6b-q4km' || lock.platform !== 'win32' || lock.arch !== 'x64'
      || JSON.stringify(lock.contract) !== JSON.stringify(CONTRACT)) throw failure('ASSET_INTEGRITY_FAILED');
    const expected = new Set(['native.lock.json', ...lock.files.map(file => file.path)]);
    function walk(dir, prefix = '') {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const relative = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isSymbolicLink()) throw failure('ASSET_INTEGRITY_FAILED');
        if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
        else if (!entry.isFile() || !expected.delete(relative)) throw failure('ASSET_INTEGRITY_FAILED');
      }
    }
    walk(root); if (expected.size) throw failure('ASSET_INTEGRITY_FAILED');
    for (const file of lock.files) {
      if (!/^[\w./-]+$/.test(file.path) || file.path.split('/').includes('..')) throw failure('ASSET_INTEGRITY_FAILED');
      const target = path.join(root, file.path);
      if (regular(target).size !== file.bytes || await digest(target, deadline, signal) !== file.sha256) throw failure('ASSET_INTEGRITY_FAILED');
    }
    return { lock };
  } catch (error) {
    check(deadline, signal);
    const result = failure(error.code === 'ENOENT' ? 'MODEL_NOT_INSTALLED' : 'ASSET_INTEGRITY_FAILED');
    result.nativeAvailability = true; throw result;
  }
}
async function availablePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

// A helper closing is not evidence that its native child exited. Keep exact
// owners strongly referenced until the launcher's independent proof completes.
function createNativeOwnerRegistry() {
  const roots = new Map();
  const key = root => process.platform === 'win32' ? String(root).toLowerCase() : String(root);
  const pending = root => [...(roots.get(key(root)) || [])].filter(record => record.cleanupStatus !== 'observed');
  function blocker(root) { return pending(root).find(record => record.cleanupRequested || record.helperClosed || record.cleanupStatus === 'unknown'); }
  function adopt(root, owner, { direct = false, onClosed = () => {}, onFinalized = () => {} } = {}) {
    const target = owner?.child;
    if (!target || typeof target.once !== 'function') throw failure('INVALID_NATIVE_LAUNCH');
    const records = roots.get(key(root)) || new Set(); roots.set(key(root), records);
    const record = { owner, child: target, direct, helperClosed: false, cleanupRequested: false, cleanupStatus: 'pending', cleanupError: null };
    records.add(record);
    let resolveClosed;
    const helperClosed = new Promise(resolve => { resolveClosed = resolve; });
    const closed = () => { if (record.helperClosed) return; record.helperClosed = true; onClosed(record); resolveClosed(); };
    target.once('close', closed);
    if (target.exitCode !== null && target.exitCode !== undefined || target.signalCode !== null && target.signalCode !== undefined) Promise.resolve().then(closed);
    const evidence = owner.exited || (direct ? helperClosed.then(() => ({ cleanupStatus: 'observed' })) : Promise.resolve({ cleanupStatus: 'unknown' }));
    record.finalized = Promise.allSettled([helperClosed, evidence]).then(results => {
      const result = results[1];
      record.cleanupStatus = result.status === 'fulfilled' && result.value?.cleanupStatus === 'observed' ? 'observed' : 'unknown';
      record.outcome = result.status === 'fulfilled' ? result.value : { cleanupStatus: 'unknown' };
      if (result.status === 'rejected') record.cleanupError = result.reason;
      if (record.cleanupStatus === 'observed') { records.delete(record); if (!records.size) roots.delete(key(root)); }
      onFinalized(record); return record.outcome;
    });
    return record;
  }
  async function terminate(record, reason) {
    if (!record) return { cleanupStatus: 'observed' };
    record.cleanupRequested = true; record.reason = reason;
    if (!record.terminating) {
      record.child.ref?.();
      record.terminating = (async () => {
        try {
          if (typeof record.owner.terminate === 'function') await record.owner.terminate(reason);
          else if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill('SIGKILL');
        } catch (error) {
          record.cleanupError = error;
          // Killing a pinned job host closes its kernel job; proof is still
          // required, and an unknown result can never become "clean" here.
          if (!record.helperClosed) { try { record.child.kill('SIGKILL'); } catch {} }
        }
        await record.finalized; return record.outcome;
      })();
    }
    return record.terminating;
  }
  return { adopt, terminate, blocker, pending };
}
const ownerRegistry = createNativeOwnerRegistry();

function create(options = {}) {
  const root = typeof options.root === 'string' && path.isAbsolute(options.root) ? path.resolve(options.root) : null;
  const stateRoot = path.resolve(options.stateRoot || os.tmpdir());
  const startupMs = Math.min(20000, Math.max(100, Number(options.startupMs) || 20000));
  const idleMs = Math.max(10, Math.min(60000, Number(options.idleMs) || 60000));
  const implementationSha256 = hash(semanticNativeFactory.toString());
  let child = null, base = '', apiKey = '', ready = null, starting = null, startupController = null, startupError = null, active = false, stopping = null, closingCount = 0, generation = 0;
  const recentMs = { query: 150, document: 150 };
  let state = 'cold', diagnosticCode = '', retryAt = 0, idleTimer = null, lifetimeEnded = false; const owned = new WeakMap(), localOwners = new Set();
  const stats = { verifications: 0, starts: 0, tokenizeWrites: 0, embeddingWrites: 0, completedTexts: 0, kills: 0 };
  function estimateEncodingBudget(role, count) {
    if (!['query', 'document'].includes(role) || !Number.isInteger(count) || count < 1 || count > 16) throw failure('INVALID_BUDGET_REQUEST');
    // The host and native admission use this exact whole-batch estimate. No
    // text is inspected; keep room for the final source/authority callback.
    return Math.min(60000, Math.ceil(Math.max(150, recentMs[role] * 1.2) * count + 32));
  }
  const descriptor = () => { const blocked = ownerRegistry.blocker(root); return ({ ok: !!ready && !!child && !blocked, available: !!ready && !!child && !blocked,
    state: blocked ? blocked.cleanupStatus === 'unknown' ? 'cleanup-unknown' : 'cleanup-pending' : state, ...(ready || {}),
    minimumScore: .44, searchThreshold: .44, retrievalThresholds: { search: .44, automatic: null },
    modelId: 'qwen3-embedding-0.6b-q4km', dimensions: 1024, maxTokens: 512,
    backend: 'llama.cpp-cpu', implementationSha256, recommendedChunkChars: 96,
    ...(blocked ? { cleanupStatus: blocked.cleanupStatus, diagnostic: { code: blocked.cleanupStatus === 'unknown' ? 'NATIVE_CLEANUP_UNCONFIRMED' : 'NATIVE_CLEANUP_PENDING' } }
      : diagnosticCode ? { diagnostic: { code: diagnosticCode } } : {}) }); };
  const unavailable = (reason = 'unavailable') => ({ ...descriptor(), ok: false, available: false, reason });
  async function enabled() { return !lifetimeEnded && typeof options.enabled === 'function' && await options.enabled(); }
  function armIdle() {
    clearTimeout(idleTimer); idleTimer = null;
    if (!active && child && ready) {
      idleTimer = setTimeout(() => { void stop('idle').catch(() => { diagnosticCode = 'NATIVE_STOP_FAILED'; }); }, idleMs);
      idleTimer.unref?.();
    }
  }
  function parentClosed() {
    lifetimeEnded = true;
    void stop('parent-eof').catch(() => { diagnosticCode = 'NATIVE_STOP_FAILED'; });
  }
  if (options.parentStream) {
    options.parentStream.once('end', parentClosed); options.parentStream.once('close', parentClosed);
  }

  async function terminate(target, reason) {
    if (!target) return;
    const record = owned.get(target); if (!record) throw failure('UNOWNED_PROCESS');
    if (!record.cleanupRequested) stats.kills++;
    if (child === target) { ready = null; base = ''; apiKey = ''; }
    closingCount++;
    try { return await ownerRegistry.terminate(record, reason); } finally { closingCount--; }
  }
  async function stop(reason = 'stopped') {
    generation++; state = reason; ready = null; startupError = null; clearTimeout(idleTimer); idleTimer = null;
    retryAt = 0;
    startupController?.abort(failure('STOPPED'));
    stopping = Promise.all([...localOwners].map(record => terminate(record.child, reason))); await stopping; stopping = null;
    // Abort also closes a verification stream; await its owner before returning.
    if (starting) await starting.catch(() => {});
    const blocked = ownerRegistry.blocker(root);
    return { ok: !blocked && !localOwners.size, state: blocked ? 'cleanup-unknown' : reason,
      workerExited: !blocked && !localOwners.size, cleanupStatus: blocked ? blocked.cleanupStatus : 'observed',
      ...(blocked ? { diagnostic: { code: 'NATIVE_CLEANUP_UNCONFIRMED' } } : {}) };
  }
  function environment(home) {
    for (const name of ['AppData/Local', 'AppData/Roaming', 'ProgramData', 'Temp', 'cache']) fs.mkdirSync(path.join(home, name), { recursive: true });
    return { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC,
      PATH: path.join(root, 'runtime/win32-x64') + ';' + path.join(process.env.SystemRoot, 'System32'),
      USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
      PROGRAMDATA: path.join(home, 'ProgramData'), TEMP: path.join(home, 'Temp'), TMP: path.join(home, 'Temp'),
      HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', LLAMA_CACHE: path.join(home, 'cache'), LLAMA_ARG_OFFLINE: '1' };
  }
  async function launch(deadline, signal, hardFailure) {
    const epoch = generation; state = 'loading';
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      const error = failure('PLATFORM_UNSUPPORTED'); error.nativeAvailability = true; throw error;
    }
    stats.verifications++;
    const verified = await verify(root, deadline, signal); check(deadline, signal);
    if (epoch !== generation) throw failure('STOPPED');
    const port = await availablePort(); check(deadline, signal);
    if (epoch !== generation) throw failure('STOPPED');
    let home;
    try { fs.mkdirSync(stateRoot, { recursive: true }); home = fs.mkdtempSync(path.join(stateRoot, 'ruyi-semantic-native-')); }
    catch { const error = failure('NATIVE_STATE_UNAVAILABLE'); error.nativeAvailability = true; throw error; }
    apiKey = crypto.randomBytes(32).toString('hex');
    const args = ['--model', path.join(root, verified.lock.modelPath), '--offline', '--embedding', '--pooling', 'last',
      '--embd-normalize', '2', '--n-gpu-layers', '0', '--ctx-size', '512', '--batch-size', '512', '--ubatch-size', '512',
      '--parallel', '1', '--threads', '2', '--threads-batch', '2', '--fit', 'off', '--no-webui', '--no-webui-mcp-proxy',
      '--no-cache-prompt', '--host', '127.0.0.1', '--port', String(port), '--api-key', apiKey];
    const command = path.join(root, verified.lock.runtimeEntry), spawnOptions = { cwd: home, env: environment(home), windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'] };
    let launched, attemptOwner;
    const onOwned = owner => {
      const target = owner?.child;
      const record = ownerRegistry.adopt(root, owner, { direct: !options.launchNative,
        onClosed: () => {
          if (child === target) { ready = null; base = ''; apiKey = ''; state = 'cleanup-pending'; }
        },
        onFinalized: final => {
          if (final.cleanupStatus !== 'observed') { diagnosticCode = 'NATIVE_CLEANUP_UNCONFIRMED'; return; }
          localOwners.delete(final); liveChildren.delete(target);
          // The observer may still need this directory after helper.close.
          // Only exact observed native exit authorizes its removal.
          if (path.dirname(path.resolve(home)) === stateRoot && path.basename(home).startsWith('ruyi-semantic-native-')) {
            try { fs.rmSync(home, { recursive: true, force: true }); } catch { diagnosticCode = 'NATIVE_STATE_CLEANUP_FAILED'; }
          }
          if (child === target) { child = null; base = ''; apiKey = ''; ready = null; state = final.reason || 'unavailable'; }
        } });
      record.home = home; owned.set(target, record); localOwners.add(record);
      target.unref?.(); liveChildren.add(target); target.on('error', () => {});
      if (attemptOwner) throw failure('DUPLICATE_NATIVE_OWNER');
      attemptOwner = record; child = target; base = 'http://127.0.0.1:' + port; stats.starts++;
    };
    try {
      launched = options.launchNative ? await options.launchNative({ command, args, spawnOptions, signal, deadline, onOwned })
        : { child: (options.spawn || cp.spawn)(command, args, spawnOptions) };
      if (!attemptOwner) {
        onOwned(launched);
        if (options.launchNative) throw failure('NATIVE_OWNER_HANDOFF_REQUIRED');
      }
      if (attemptOwner.owner !== launched) throw failure('NATIVE_OWNER_CHANGED');
    } catch (error) {
      if (attemptOwner) await terminate(attemptOwner.child, 'launch-failed');
      // A custom launcher owns its error classification. Never downgrade an
      // authority error supplied by the host as ordinary model availability.
      if (options.launchNative || options.spawn) {
        if (!error?.nativeAvailability && !['DEADLINE_EXCEEDED', 'STOPPED'].includes(error?.code)) hardFailure.primary = { value: error };
        throw error;
      }
      check(deadline, signal);
      const failed = failure('NATIVE_START_FAILED'); failed.nativeAvailability = true; throw failed;
    }
    const target = attemptOwner.child;
    try {
      let identity;
      try { identity = typeof launched.getNativeIdentity === 'function' ? launched.getNativeIdentity() : launched; }
      catch (error) { hardFailure.primary = { value: error }; throw error; }
      const nativePid = identity.nativePid || (!options.launchNative ? target.pid : null);
      if (!Number.isSafeInteger(nativePid) || nativePid <= 0 || launched.fingerprint !== undefined
        && !/^(?:sha256:)?[a-f0-9]{64}$/.test(launched.fingerprint)) throw failure('INVALID_NATIVE_LAUNCH');
      while (true) {
        check(deadline, signal); if (epoch !== generation) throw failure('STOPPED');
        if (target.exitCode !== null || target.signalCode !== null) throw failure('WORKER_EXITED');
        const observed = await promisify(cp.execFile)(path.join(process.env.SystemRoot, 'System32/netstat.exe'), ['-ano', '-p', 'TCP'],
          { windowsHide: true, encoding: 'utf8', timeout: Math.max(1, Math.min(1000, deadline - Date.now())), maxBuffer: 4 * 1024 * 1024, signal });
        check(deadline, signal);
        if (ownsListener(observed.stdout, port, nativePid)) {
          try { const response = await fetch(base + '/health', { headers: { Authorization: 'Bearer ' + apiKey },
            signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(250, deadline - Date.now()))), ...(signal ? [signal] : [])]) }); if (response.ok) break; }
          catch { check(deadline, signal); }
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      check(deadline, signal); if (epoch !== generation) throw failure('STOPPED');
      const modelFingerprint = 'sha256:' + hash(JSON.stringify([PIN.lock, verified.lock.contract, verified.lock.retrievalThresholds, implementationSha256,
        launched.fingerprint || 'direct-node-child-v1']));
      ready = { modelFingerprint, contract: CONTRACT }; state = 'ready'; diagnosticCode = ''; armIdle(); return descriptor();
    } catch (error) { await terminate(target, signal?.aborted ? 'cancelled' : 'unavailable'); throw error; }
  }
  async function prepare(opts = {}) {
    const deadline = Math.min(Date.now() + startupMs, boundedDeadline(opts, startupMs));
    checkSignal();
    function checkSignal() { if (opts.signal?.aborted) throw opts.signal.reason || failure('CANCELLED'); }
    // Configuration/authority failures belong to the host, not asset fallback.
    if (!await enabled()) { await stop('disabled'); return unavailable('disabled'); }
    checkSignal();
    // A background owner's hard failure belongs to this client. Unknown
    // cleanup blocks reuse, but must not hide the already captured authority error.
    if (startupError) throw startupError;
    if (Date.now() >= deadline) return { ...descriptor(), ok: false, available: false, state: 'timeout', reason: 'timeout', error: { code: 'DEADLINE_EXCEEDED' } };
    const unconfirmed = ownerRegistry.blocker(root);
    if (unconfirmed) {
      if (unconfirmed.cleanupError?.code === 'JOB_INTEGRITY') throw unconfirmed.cleanupError;
      return unavailable();
    }
    if (Date.now() < retryAt) return unavailable();
    // One startup owner. A later caller never inherits its wait/deadline or kills it.
    if (starting || stopping || closingCount) return { ...descriptor(), ok: false, available: false, state: 'loading', reason: 'overloaded', error: { code: 'PREPARE_BUSY' } };
    if (ready && child) return descriptor();
    startupController = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, startupController.signal]) : startupController.signal;
    // A foreground search must not restart 443MB integrity verification on every
    // 1s deadline. Preparation has its own bounded owner and contains no user text.
    const background = deadline - Date.now() <= 1000;
    const startupDeadline = background ? Date.now() + startupMs : deadline;
    const hardFailure = {};
    starting = (async () => {
      try { await launch(startupDeadline, signal, hardFailure); check(startupDeadline, signal); return descriptor(); }
      catch (error) {
        if (opts.signal?.aborted) { await terminate(child, 'cancelled'); state = 'cancelled'; throw opts.signal.reason || error; }
        // Cleanup can cross the deadline after a host/owner authority failure.
        // Preserve its identity before classifying ordinary time exhaustion.
        if (hardFailure.primary || ['EACCES', 'EPERM'].includes(error?.code)) {
          const primary = hardFailure.primary ? hardFailure.primary.value : error;
          state = 'unavailable'; if (background) startupError = primary;
          throw primary;
        }
        if (Date.now() >= startupDeadline || error?.code === 'DEADLINE_EXCEEDED') {
          await terminate(child, 'timeout'); state = 'timeout'; return { ...descriptor(), ok: false, available: false, state: 'timeout', reason: 'timeout', error: { code: 'DEADLINE_EXCEEDED' } };
        }
        if (signal.aborted && signal.reason?.code === 'STOPPED') return { ...descriptor(), ok: false, available: false, state: 'stopped', reason: 'unavailable', error: { code: 'STOPPED' } };
        if (error?.nativeAvailability || ['WORKER_EXITED', 'STOPPED', 'LISTENER_IDENTITY_FAILED'].includes(error?.code)) {
          state = 'unavailable'; diagnosticCode = error.code; retryAt = Date.now() + 30000; return unavailable();
        }
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
    if (!Array.isArray(texts) || !texts.length || texts.length > 16 || texts.some(text => typeof text !== 'string' || !text.length || text.length > 8192)
      || texts.reduce((total, text) => total + text.length, 0) > 32768 || Buffer.byteLength(JSON.stringify(texts), 'utf8') > 256 * 1024
      || !['query', 'document'].includes(opts.role)) return { ok: false, state: 'invalid', reason: 'unavailable', error: { code: 'INVALID_REQUEST' } };
    const deadline = Math.min(Date.now() + 1000, boundedDeadline(opts, 1000));
    if (opts.signal?.aborted) throw opts.signal.reason || failure('CANCELLED');
    if (Date.now() >= deadline) return { ok: false, state: 'timeout', reason: 'timeout', completed: 0,
      completedVectors: [], error: { code: 'INSUFFICIENT_BUDGET' } };
    if (active) return { ok: false, state: 'busy', reason: 'overloaded', error: { code: 'BUSY' }, completed: 0, completedVectors: [] };
    active = true; clearTimeout(idleTimer); idleTimer = null; const vectors = [], encodedTokens = [], epoch = generation; let guardError = null, wrote = false;
    const finish = (state, code) => ({ ok: vectors.length === texts.length, state,
      ...(vectors.length === texts.length ? { vectors } : { completedVectors: vectors }), encodedTokens, completed: vectors.length,
      total: texts.length, coverage: { complete: vectors.length === texts.length, encoded: vectors.length, total: texts.length },
      ...(ready || {}), ...(code ? { reason: ['INSUFFICIENT_BUDGET', 'DEADLINE_EXCEEDED'].includes(code) ? 'timeout' : 'unavailable', error: { code } } : {}) });
    async function guard() {
      check(deadline, opts.signal);
      let allowed;
      try { allowed = await enabled(); } catch (error) { guardError = { value: error }; throw error; }
      if (!allowed) { await stop('disabled'); throw failure('DISABLED'); }
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
      if (error?.code === 'DISABLED') return { ...finish('disabled', 'DISABLED'), reason: 'disabled' };
      if (['DEADLINE_EXCEEDED', 'STOPPED'].includes(error?.code)) {
        if (error.code === 'DEADLINE_EXCEEDED' && wrote) await terminate(child, 'timeout');
        return finish(vectors.length ? 'partial' : 'timeout', error.code);
      }
      if (['INVALID_VECTOR', 'TOKEN_CONTRACT_FAILED', 'NATIVE_HTTP_ERROR', 'WORKER_EXITED'].includes(error?.code)) {
        await terminate(child, 'unavailable'); return finish('unavailable', error.code);
      }
      throw error; // Source/authority guards keep their original identity and are never swallowed.
    } finally { active = false; armIdle(); }
  }
  return { descriptor, prepare, encode, stop, estimateEncodingBudget, stats: () => ({ ...stats, recentMs: { ...recentMs }, state,
    processAlive: !!child && child.exitCode === null && child.signalCode === null, pid: child?.pid || null,
    nativePid: child ? (owned.get(child)?.owner.getNativeIdentity?.().nativePid || owned.get(child)?.owner.nativePid || (owned.get(child)?.direct ? child.pid : null)) : null,
    cleanupStatus: ownerRegistry.blocker(root)?.cleanupStatus || (localOwners.size ? 'pending' : 'observed'),
    unconfirmedOwners: ownerRegistry.pending(root).filter(record => record.cleanupRequested || record.helperClosed).length }) };
}
return Object.freeze({ create, contract: CONTRACT, profileLockSha256: PIN.lock });
})();
