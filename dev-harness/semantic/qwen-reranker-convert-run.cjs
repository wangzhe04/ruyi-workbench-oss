'use strict';
// Whitelisted environment and marker/path proofs precede process creation.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const { killOwnTree } = require('../lib/kill-own-tree.js');
const root = path.resolve('output/semantic-qwen-reranker-official-v1');
const read = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const inputs = read(path.join(root, 'conversion-inputs.lock.json')), source = inputs.converterSource;
if (read(path.join(root, 'OWNER.json')).owner !== 'sol_semantic_runtime') throw Error('Research owner mismatch.');
function verifySource() { for (const file of inputs.files) if (hash(path.join(source, file.path)) !== file.sha256) throw Error('Pinned source changed: ' + file.path); }
async function verifyModelSource() {
  const metadata = read(path.join(root, 'metadata-receipt.json'));
  for (const file of metadata.files) if (hash(path.join(root, 'source/Qwen3-Reranker-0.6B', file.path)) !== file.sha256) throw Error('Official metadata changed.');
  const model = path.join(root, 'source/Qwen3-Reranker-0.6B/model.safetensors'), digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(model)) digest.update(chunk);
  const sha256 = digest.digest('hex');
  if (sha256 !== '27cd75a405b9c1b46b59abfd88aaa209e6fed2a1972cde9b70e7659537c5e65b' || fs.statSync(model).size !== 1191588280) throw Error('Official model changed.');
  return { sha256, bytes: 1191588280, metadataFiles: metadata.files.length };
}
verifySource();
const sandbox = path.join(root, 'conversion-sandbox-v1');
fs.mkdirSync(sandbox); fs.writeFileSync(path.join(sandbox, 'OWNER.json'), JSON.stringify({ owner: 'sol_semantic_runtime', purpose: 'Offline official reranker conversion', root }, null, 2) + '\n', { flag: 'wx' });
const dirs = Object.fromEntries(['profile', 'roaming', 'local', 'hf', 'temp', 'cache'].map(name => {
  const directory = path.join(sandbox, name); fs.mkdirSync(directory); return [name, directory];
}));
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC,
  PATH: path.join(root, 'converter-venv/Scripts') + ';' + path.join(process.env.SystemRoot, 'System32'),
  HOME: dirs.profile, USERPROFILE: dirs.profile, APPDATA: dirs.roaming, LOCALAPPDATA: dirs.local, HF_HOME: dirs.hf,
  TEMP: dirs.temp, TMP: dirs.temp, XDG_CACHE_HOME: dirs.cache, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
  HF_DATASETS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2', CUDA_VISIBLE_DEVICES: '' };
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HF_HOME', 'TEMP', 'TMP', 'XDG_CACHE_HOME']) {
  const target = path.resolve(env[key]), relative = path.relative(sandbox, target);
  if (!path.isAbsolute(env[key]) || !relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(target).isSymbolicLink()) throw Error('Non-owner environment path: ' + key);
}
const output = path.join(root, 'artifacts/qwen3-reranker-0.6b-rank-f16.gguf');
if (fs.existsSync(output) || fs.existsSync(path.join(root, 'conversion-preflight.json'))) throw Error('Preserve previous output; no overwrites.');
const python = path.join(root, 'converter-venv/Scripts/python.exe'), entry = path.resolve(__dirname, 'qwen-reranker-converter-entry.py');
const logfile = path.join(root, 'converter-f16-strict.log'), fd = fs.openSync(logfile, 'wx'), startedAt = Date.now();
const report = { schemaVersion: 1, startedAt: new Date(startedAt).toISOString(), status: 'RUNNING', beforeSourceMatchesPinnedZIP: true,
  args: ['-I', entry, root, source, output], executable: python, cwd: sandbox, environment: env,
  scripts: [__filename, entry].map(file => ({ file, sha256: hash(file) })), sourceLockSha256: hash(path.join(root, 'conversion-inputs.lock.json')) };
let child;
const interrupted = () => { if (child) killOwnTree(child); };
process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
(async () => { try {
  report.modelSourceBefore = await verifyModelSource();
  child = cp.spawn(python, report.args, { cwd: sandbox, env, windowsHide: true, stdio: ['ignore', fd, fd] });
  report.childPid = child.pid;
  child.once('error', error => { report.spawnError = String(error); });
  child.once('close', async (code, signal) => {
    fs.closeSync(fd); report.exitCode = code; report.signal = signal; report.elapsedMs = Date.now() - startedAt;
    try { verifySource(); report.modelSourceAfter = await verifyModelSource(); report.afterSourceMatchesPinnedZIP = true; } catch (error) { report.sourceError = String(error); }
    report.status = code === 0 && !report.spawnError && report.afterSourceMatchesPinnedZIP && fs.existsSync(path.join(root, 'conversion-preflight.json')) ? 'PASS' : 'FAIL';
    fs.writeFileSync(path.join(root, 'converter-f16-strict-execution.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: report.status, exitCode: code, elapsedMs: report.elapsedMs, childPid: report.childPid, sourceStable: report.afterSourceMatchesPinnedZIP }));
    if (report.status !== 'PASS') process.exitCode = 1;
  });
} catch (error) { fs.closeSync(fd); console.error(error); process.exitCode = 1; } })();
