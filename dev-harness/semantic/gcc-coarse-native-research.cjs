'use strict';
// Research-only adaptation of the reviewed native owner. No fixtures, saved
// vectors or production registration. Asset locations and hashes are fixed.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const basePath = path.join(__dirname, 'native-host-prototype.cjs');
const baseSha = '9c98eb4a635a7748a51973a2c6789accc63a1cb2357309d470b16711506e4f21';
const exe = 'C:/r31-gcc-rank-research/build/bin/llama-server.exe';
const model = path.resolve(__dirname, '../../output/semantic-native-win32-x64-v1/models/qwen3-embedding-0.6b-q4km/model.gguf');
const profileLock = path.join(__dirname, 'gcc-native-profile-lock.json');
const profileLockSha = '5bd146943d81c623e64d497c35231a5d2dea798fa9b5454f26e06a8d8724d28c';
const pins = Object.freeze({ exe: '6e03bcaf87e96763730f41352732c72a9fe19a12baa2e588bafba85cda05bb3f', model: '23d234bb57a42528a22a13e7beb8b57d8844b2b9cc741b4c27a8ff132abf0dfd' });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
let source = fs.readFileSync(basePath, 'utf8');
if (hash(source) !== baseSha) throw Error('gcc.coarse_base_changed');
function replaceOnce(before, after) {
  if (source.split(before).length !== 2) throw Error('gcc.coarse_transform_changed');
  source = source.replace(before, after);
}
replaceOnce('Given a web search query, retrieve relevant passages that answer the query', 'Given a user question, retrieve prior messages that contain evidence relevant to answering it');
replaceOnce("const PIN = Object.freeze({ lock: '2e47371f2bf6bce13ce23d0f182c7f31d492e2ef5d17ba43b1b64f3ba3b3a0f0' });", `const PIN = Object.freeze({ lock: '${profileLockSha}' });`);
const verifyStart = source.indexOf('async function verify(root, deadline, signal) {');
const verifyEnd = source.indexOf('async function availablePort()', verifyStart);
if (verifyStart < 0 || verifyEnd < 0) throw Error('gcc.coarse_verify_boundary_changed');
source = source.slice(0, verifyStart) + `async function verify(root, deadline, signal) {
  for (const [file, expected] of [[${JSON.stringify(profileLock)}, ${JSON.stringify(profileLockSha)}], [${JSON.stringify(exe)}, ${JSON.stringify(pins.exe)}], [${JSON.stringify(model)}, ${JSON.stringify(pins.model)}]]) {
    regular(file); if (await digest(file, deadline, signal) !== expected) throw failure('ASSET_INTEGRITY_FAILED');
  }
  return { lock: { modelPath: ${JSON.stringify(model)}, runtimeEntry: ${JSON.stringify(exe)}, contract: CONTRACT, retrievalThresholds: { search: null, automatic: null } } };
}\n` + source.slice(verifyEnd);
replaceOnce("path.join(root, verified.lock.modelPath)", 'verified.lock.modelPath');
replaceOnce("path.join(root, verified.lock.runtimeEntry)", 'verified.lock.runtimeEntry');
replaceOnce("'--ctx-size', '512'", "'--ctx-size', '1024'");
replaceOnce("'--no-cache-prompt', '--host'", "'--no-cache-prompt', '--slots', '--slot-save-path', path.join(home, 'cache') + path.sep, '--host'");
replaceOnce("const modelFingerprint = 'sha256:' + hash(JSON.stringify([PIN.lock,",
  "const slotsResponse = await fetch(base + '/slots', { headers: { Authorization: 'Bearer ' + apiKey }, signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))), ...(signal ? [signal] : [])]) });\n      if (!slotsResponse.ok) throw failure('NATIVE_SLOT_CONTRACT'); const slots = await slotsResponse.json(); check(deadline, signal); if (epoch !== generation || !Array.isArray(slots) || slots.length !== 1 || slots[0].n_ctx !== 1024) throw failure('NATIVE_SLOT_CONTRACT');\n      const modelFingerprint = 'sha256:' + hash(JSON.stringify([PIN.lock,");
replaceOnce("stats.embeddingWrites++; const result = await request('/v1/embeddings',", "const erased = await request('/slots/0?action=erase', {}, target); if (!erased || Array.isArray(erased) || Object.keys(erased).sort().join(',') !== 'id_slot,n_erased' || erased.id_slot !== 0 || !Number.isSafeInteger(erased.n_erased) || erased.n_erased < 0) throw failure('INVALID_SLOT_ERASE'); stats.eraseWrites = (stats.eraseWrites || 0) + 1; await guard(); stats.embeddingWrites++; const result = await request('/v1/embeddings',");
replaceOnce("!Array.isArray(tokens.tokens) || tokens.tokens.length > 512 || tokens.tokens.at(-1) !== 151643",
  "!Array.isArray(tokens.tokens) || !tokens.tokens.length || tokens.tokens.length > 512 || !tokens.tokens.every(Number.isSafeInteger) || tokens.tokens.at(-1) !== 151643");
replaceOnce("const vectors = [], encodedTokens = [], epoch = generation;",
  "const vectors = [], encodedTokens = [], encodedTokenHashes = [], encodedLastTokens = [], epoch = generation;");
replaceOnce("completedVectors: vectors }), encodedTokens, completed: vectors.length,",
  "completedVectors: vectors }), encodedTokens, encodedTokenHashes, encodedLastTokens, completed: vectors.length,");
replaceOnce("vectors.push(vector); encodedTokens.push(tokens.tokens.length); stats.completedTexts++;",
  "vectors.push(vector); encodedTokens.push(tokens.tokens.length); encodedTokenHashes.push(hash(JSON.stringify(tokens.tokens))); encodedLastTokens.push(tokens.tokens.at(-1)); stats.completedTexts++;");
replaceOnce("check(deadline, opts.signal); if (epoch !== generation) throw failure('STOPPED');",
  "check(deadline, opts.signal); if (epoch !== generation || ownerRegistry.blocker(root)) throw failure('STOPPED');");
replaceOnce("if (['INVALID_VECTOR', 'TOKEN_CONTRACT_FAILED', 'NATIVE_HTTP_ERROR', 'WORKER_EXITED'].includes(error?.code)) {",
  "if (error?.code === 'INVALID_SLOT_ERASE') { await terminate(child, 'invalid-slot'); throw error; }\n      if (['INVALID_VECTOR', 'TOKEN_CONTRACT_FAILED', 'NATIVE_HTTP_ERROR', 'WORKER_EXITED'].includes(error?.code)) {");
replaceOnce("if (cancelled) throw opts.signal.reason || error;",
  "if (cancelled && (error === opts.signal.reason || ['AbortError', 'TimeoutError'].includes(error?.name) || error?.code === 'ABORT_ERR')) throw opts.signal.reason === undefined ? error : opts.signal.reason;");
replaceOnce("if (opts.signal?.aborted) { await terminate(child, 'cancelled'); throw opts.signal.reason || error; }",
  "if (opts.signal?.aborted && (error === opts.signal.reason || ['AbortError', 'TimeoutError'].includes(error?.name) || error?.code === 'ABORT_ERR')) { await terminate(child, 'cancelled'); throw opts.signal.reason === undefined ? error : opts.signal.reason; }");
replaceOnce("if (opts.signal?.aborted) { await terminate(child, 'cancelled'); state = 'cancelled'; throw opts.signal.reason || error; }",
  "if (opts.signal?.aborted && (error === opts.signal.reason || ['AbortError', 'TimeoutError'].includes(error?.name) || error?.code === 'ABORT_ERR')) { await terminate(child, 'cancelled'); state = 'cancelled'; throw opts.signal.reason === undefined ? error : opts.signal.reason; }");
replaceOnce("minimumScore: .44, searchThreshold: .44, retrievalThresholds: { search: .44, automatic: null },", "minimumScore: null, searchThreshold: null, retrievalThresholds: { search: null, automatic: null },");
source = source.replaceAll("opts.signal.reason || failure('CANCELLED')", "(opts.signal.reason === undefined ? failure('CANCELLED') : opts.signal.reason)")
  .replaceAll("throw signal.reason || failure('CANCELLED')", "throw (signal.reason === undefined ? failure('CANCELLED') : signal.reason)")
  .replaceAll('opts.signal.reason || error', '(opts.signal.reason === undefined ? error : opts.signal.reason)');
const compiled = new Module(__filename, module); compiled.filename = __filename; compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(source + '\nmodule.exports = SemanticNativeClient;\n', __filename);
const controller = compiled.exports;
const { createJobLauncher } = require('./native-job-launcher.cjs');
const launchNative = createJobLauncher({ helperPath: path.resolve(__dirname, '../../output/semantic-native-job-host/native-job-host.exe'),
  sourcePath: path.join(__dirname, 'native-job-host.cs'), helperSha256: 'c0c4a019131cce574be6f674e9ca3ad4597fe72f39ddb4194de5cfc2577edc7d',
  sourceSha256: 'e8457aaacfa525806461e9e33a185d46106eb06bf285bb8492f73deb67b2a734' });
function create() {
  let owner = null;
  const native = controller.create({ root: path.resolve('output/semantic-native-mingw-research/coarse-owner'), enabled: async () => true,
    launchNative: args => launchNative({ ...args, onOwned(value) { owner = value; args.onOwned(value); } }) });
  return Object.freeze({ ...native, async encode(texts, opts) {
    const value = await native.encode(Array.isArray(texts) ? texts.slice() : texts, opts && { ...opts });
    if (value.ok) return value;
    const { completedVectors, ...partial } = value; return partial;
  }, identity() { const value = owner?.getNativeIdentity?.(); return value?.nativePid
    ? { pid: value.nativePid, creationFileTime: value.creationFileTime ?? null } : null; } });
}
module.exports = { create, pins, baseSha, exe, model };
