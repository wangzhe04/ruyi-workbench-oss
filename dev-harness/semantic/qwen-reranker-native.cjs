'use strict';
// Isolated research verifier. Never installs/downloads or changes production.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), net = require('node:net'), cp = require('node:child_process');
const { once } = require('node:events'), { promisify } = require('node:util');
const { createJobLauncher } = require('./native-job-launcher.cjs');
const root = path.resolve('output/semantic-qwen-reranker-official-v1');
const MODEL_SHA = '9787224d2920d37838ed8dcf88dc6f2b92d1629192627655c32b06aef04becc7';
const PROFILES = Object.freeze({
  control: { directory: 'runtime/control', lock: 'runtime/control.lock.json', sha256: '5286bb7d88d001c693c8b5fb19ba5ba2f2d7a6e7b9fa6e55d82b670dd7afbbb0', threads: 2 },
  'rank-buffer-t6': { directory: 'runtime/rank-buffer-t6', lock: 'runtime/rank-buffer-t6.lock.json', sha256: 'c703f828ce9ad6e423593c9baa44f5901dbce9a9776a8a3850f640e3f2799ee6', threads: 6 },
});
const read = file => JSON.parse(fs.readFileSync(file)), hash = x => crypto.createHash('sha256').update(x).digest('hex');
async function digest(file) { const value = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) value.update(chunk); return value.digest('hex'); }
function check(signal) { if (signal?.aborted) throw signal.reason === undefined ? Error('CANCELLED') : signal.reason; }
async function freePort() { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function createVerifier(options = {}) {
  const profileId = options.profile === undefined ? 'control' : options.profile;
  if (typeof profileId !== 'string' || !Object.hasOwn(PROFILES, profileId)) throw Error('Unknown locked research runtime profile.');
  const profile = PROFILES[profileId];
  const auditPath = path.join(root, 'artifact-inventory.json');
  if (hash(fs.readFileSync(auditPath)) !== '3f442df23bb4e4eb5e14da9f59a3ee5d9770dfc6fd266deb44e2d22060abe204') throw Error('Artifact audit pin mismatch.');
  const audit = read(auditPath), model = path.join(root, 'artifacts/qwen3-reranker-0.6b-rank-q4_k_m.gguf');
  if (audit.status !== 'PASS' || audit.artifacts.q4_k_m.sha256 !== MODEL_SHA || await digest(model) !== MODEL_SHA) throw Error('Reranker model integrity failed.');
  const runtimeLockPath = path.join(root, profile.lock), runtimeLock = read(runtimeLockPath), runtime = path.join(root, profile.directory);
  if (hash(fs.readFileSync(runtimeLockPath)) !== profile.sha256) throw Error('Runtime lock pin mismatch.');
  for (const file of runtimeLock.files) if (fs.statSync(path.join(runtime, file.path)).size !== file.bytes || await digest(path.join(runtime, file.path)) !== file.sha256) throw Error('Runtime integrity failed.');
  const template = audit.artifacts.q4_k_m.template;
  if (hash(template) !== audit.artifacts.q4_k_m.templateSha256) throw Error('Rerank template integrity failed.');
  const home = fs.mkdtempSync(path.join(root, 'native-sanity-home-'));
  fs.writeFileSync(path.join(home, 'OWNER.json'), JSON.stringify({ owner: 'sol_semantic_runtime', purpose: 'Offline synthetic reranker research' }) + '\n', { flag: 'wx' });
  for (const name of ['cache', 'temp', 'roaming', 'local', 'programdata']) fs.mkdirSync(path.join(home, name));
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC,
    PATH: runtime + ';' + path.join(process.env.SystemRoot, 'System32'), HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'), PROGRAMDATA: path.join(home, 'programdata'),
    TEMP: path.join(home, 'temp'), TMP: path.join(home, 'temp'), HF_HOME: path.join(home, 'cache'),
    HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', LLAMA_CACHE: path.join(home, 'cache'), LLAMA_ARG_OFFLINE: '1' };
  const port = await freePort(), base = 'http://127.0.0.1:' + port, apiKey = crypto.randomBytes(32).toString('hex');
  const args = ['--model', model, '--offline', '--reranking', '--pooling', 'rank', '--embd-normalize', '-1', '--n-gpu-layers', '0',
    '--ctx-size', '1024', '--batch-size', '512', '--ubatch-size', '512', '--parallel', '1', '--threads', String(profile.threads), '--threads-batch', String(profile.threads),
    '--fit', 'off', '--no-webui', '--no-webui-mcp-proxy', '--no-cache-prompt', '--slots', '--slot-save-path', path.join(home, 'cache') + path.sep,
    '--host', '127.0.0.1', '--port', String(port), '--api-key', apiKey];
  const launch = createJobLauncher({ helperPath: path.resolve('output/semantic-native-job-host/native-job-host.exe'),
    sourcePath: path.resolve(__dirname, 'native-job-host.cs'), helperSha256: 'c0c4a019131cce574be6f674e9ca3ad4597fe72f39ddb4194de5cfc2577edc7d',
    sourceSha256: 'e8457aaacfa525806461e9e33a185d46106eb06bf285bb8492f73deb67b2a734' });
  let owner, cleanup, active = false;
  const stats = { starts: 0, eraseWrites: 0, embeddingWrites: 0, rankWrites: 0, refusedOverLimit: 0 };
  const started = Date.now();
  const request = async (endpoint, body, signal, timeoutMs = 10000) => {
    const cancelledTransport = error => {
      if (signal?.aborted && (error === signal.reason || ['AbortError', 'TimeoutError'].includes(error?.name) || error?.code === 'ABORT_ERR')) throw signal.reason === undefined ? error : signal.reason;
      throw error;
    };
    check(signal); let response;
    try { response = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) }); }
    catch (error) { cancelledTransport(error); }
    if (!response.ok) { const error = Error('NATIVE_HTTP_' + response.status); try { await response.body?.cancel(); } catch {} throw error; }
    check(signal);
    try { return await response.json(); } catch (error) { cancelledTransport(error); }
  };
  async function stop() {
    if (!owner) return { cleanupStatus: 'unknown', workerExited: false };
    await owner.terminate('research-stop'); cleanup = await owner.exited;
    return { ...cleanup, workerExited: cleanup.cleanupStatus === 'observed' };
  }
  try {
    owner = await launch({ command: path.join(runtime, 'llama-server.exe'), args, spawnOptions: { cwd: home, env, windowsHide: true },
      deadline: Date.now() + 20000, onOwned: value => { owner = value; stats.starts++; } });
    let healthy = false;
    while (Date.now() - started < 20000) {
      if (owner.child.exitCode !== null || owner.child.signalCode !== null) throw Error('Native exited before health.');
      const result = await promisify(cp.execFile)(path.join(process.env.SystemRoot, 'System32/netstat.exe'), ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 1000 });
      const rows = result.stdout.split(/\r?\n/).map(x => x.trim().split(/\s+/)).filter(x => x[0] === 'TCP' && x[1] === '127.0.0.1:' + port && x[2] === '0.0.0.0:0');
      if (rows.some(x => Number(x.at(-1)) !== owner.nativePid)) throw Error('Listener owner mismatch.');
      if (rows.some(x => Number(x.at(-1)) === owner.nativePid)) {
        try { await request('/health', undefined, undefined, 500); healthy = true; break; } catch {}
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!healthy) throw Error('Native startup timeout.');
    const slots = await request('/slots');
    if (!Array.isArray(slots) || slots.length !== 1 || slots[0].n_ctx !== 1024) throw Error('Native context differs from locked 1024.');
    async function erase(signal) {
      const result = await request('/slots/0?action=erase', {}, signal);
      // b11146 server_task_result_slot_erase::to_json returns exactly these
      // fields. An HTTP success alone is not proof that our slot was cleared.
      if (!result || Array.isArray(result) || Object.keys(result).sort().join(',') !== 'id_slot,n_erased'
        || result.id_slot !== 0 || !Number.isSafeInteger(result.n_erased) || result.n_erased < 0) {
        const error = Error('Invalid native slot erase proof.'); error.code = 'INVALID_SLOT_ERASE'; throw error;
      }
      check(signal); stats.eraseWrites++;
    }
    const contract = { modelSha256: MODEL_SHA, templateSha256: hash(template), nativeContext: 1024, hostMaxJointTokens: 512,
      physicalBatch: 1, pooling: 'RANK', labels: ['yes', 'no'], nativeSoftmax: true, extraNormalization: 'none',
      runtimeProfile: profileId, runtimeLockSha256: profile.sha256, threads: profile.threads, threadsBatch: profile.threads, gpuLayers: 0,
      cache: 'validated-slot0-id-and-n_erased-before-every-inference; never-save-or-restore' };
    const fingerprint = 'sha256:' + hash(JSON.stringify([contract, hash(fs.readFileSync(runtimeLockPath)), hash(fs.readFileSync(__filename)), owner.fingerprint]));
    function prompt(query, document) { return template.replace(/\{(query|document)\}/g, (_, name) => name === 'query' ? query : document); }
    async function tokenize(query, document, signal) {
      if (typeof query !== 'string' || typeof document !== 'string' || query.length + document.length > 32768) throw Error('Invalid research pair.');
      if (/\{(?:query|document)\}/.test(query + document)) throw Error('Native template placeholder collision refused.');
      const response = await request('/tokenize', { content: prompt(query, document), add_special: false, parse_special: true }, signal);
      if (!Array.isArray(response.tokens) || !response.tokens.length || !response.tokens.every(Number.isSafeInteger)) throw Error('Invalid native tokenization.');
      return response.tokens;
    }
    async function score(query, document, options = {}) {
      // b11146's RANK embedding endpoint copies n_embd (1024) although the
      // pooled RANK buffer contains n_cls_out (2). Never probe or truncate it.
      if (options.verifyTwoClassVector) throw Error('Unsupported unsafe RANK embedding endpoint refused.');
      if (active) throw Error('Verifier busy.'); active = true;
      let guardPrimary;
      async function guard() {
        check(options.signal);
        try { if (options.beforeRerank) await options.beforeRerank(); }
        catch (error) { guardPrimary = { value: error }; throw error; }
        check(options.signal);
      }
      try {
        await guard();
        const tokens = await tokenize(query, document, options.signal);
        if (tokens.length > 512) { stats.refusedOverLimit++; return { ok: false, reason: 'joint-token-limit', tokens: tokens.length }; }
        await guard();
        await erase(options.signal);
        await guard();
        stats.rankWrites++; const begin = Date.now();
        const result = await request('/rerank', { query, documents: [document], top_n: 1 }, options.signal);
        const probability = result.results?.[0]?.relevance_score;
        if (!Number.isFinite(probability) || probability < 0 || probability > 1 || result.results.length !== 1 || result.results[0].index !== 0
          || result.usage?.prompt_tokens !== tokens.length) throw Error('Invalid RANK probability/usage contract.');
        await guard();
        return { ok: true, probability, tokens: tokens.length, elapsedMs: Date.now() - begin };
      } catch (error) {
        const primary = guardPrimary ? guardPrimary.value : error;
        try { await stop(); } catch { /* Preserve primary; final caller must still require observed exit. */ }
        throw primary;
      } finally { active = false; }
    }
    return { contract, fingerprint, adapterSourceSha256: hash(fs.readFileSync(__filename)), runtimeLockSha256: profile.sha256,
      coldReadyMs: Date.now() - started, nativePid: owner.nativePid, tokenize, score, stop, stats: () => ({ ...stats }), home };
  } catch (error) { if (owner) { try { await stop(); } catch {} } throw error; }
}
module.exports = { createVerifier };
