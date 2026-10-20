'use strict';
// No listener or CLI processes: exercise real config reads against controlled first probes.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process');
const { loadServerInternals } = require('../lib/server-internals');
const { releaseEnvironment } = require('../lib/release-checks');
const savedProcesses = new Map();
let processAttempts = 0;
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  savedProcesses.set(key, cp[key]);
  cp[key] = () => { processAttempts++; throw Error('A pure boot probe test cannot start a process.'); };
}
after(() => {
  for (const [key, value] of savedProcesses) cp[key] = value;
  assert.equal(processAttempts, 0);
});
function setup(t, explicit = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-boot-cli-unit-'));
  const envBefore = { ...process.env };
  Object.assign(process.env, releaseEnvironment(path.join(dir, 'home'), path.join(dir, 'data')));
  fs.mkdirSync(process.env.RUYI_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.RUYI_HOME, 'config.json'), JSON.stringify({
    configSchema: 13, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
    desktopMcp: { enabled: false, autodetect: false },
    ...(explicit ? { claudePath: 'configured-claude.exe', kimiPath: 'configured-kimi.exe' } : {}),
  }));
  const s = loadServerInternals(['beginBootCliPathProbes', 'finishBootCliPathProbes', 'readConfig', 'detectClaudePath', 'detectKimiPath', 'invalidateClaudePathCache'], { withEval: true });
  const pending = s.__eval(`(() => {
    const pending = [];
    detectClaudePathUncachedAsync = () => new Promise(resolve => pending.push({ kind: 'claude', resolve }));
    detectAgentCliPathUncachedAsync = () => new Promise(resolve => pending.push({ kind: 'kimi', resolve }));
    return pending;
  })()`);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
    Object.assign(process.env, envBefore);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { s, pending, dir };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('first CLI checks run concurrently; boot reads retain explicit paths and API reads wait for real results', async t => {
  const { s, pending } = setup(t);
  s.beginBootCliPathProbes(); s.beginBootCliPathProbes();
  await tick();
  assert.deepEqual(pending.map(p => p.kind), ['claude', 'kimi']);
  const boot = await s.readConfig();
  assert.equal(boot.claudePath, 'configured-claude.exe');
  assert.equal(boot.kimiPath, 'configured-kimi.exe');
  s.finishBootCliPathProbes();
  let settled = false;
  const api = s.readConfig().then(c => { settled = true; return c; });
  await tick(); assert.equal(settled, false);
  pending[0].resolve('found-claude.exe');
  await tick(); assert.equal(settled, false);
  pending[1].resolve('found-kimi.exe');
  const config = await api;
  assert.equal(config.claudePath, 'configured-claude.exe');
  assert.equal(config.kimiPath, 'configured-kimi.exe');
  assert.equal(s.detectClaudePath(), 'found-claude.exe');
  assert.equal(s.detectKimiPath(), 'found-kimi.exe');
});

test('auto paths use completed findings after listen instead of persisting provisional missing paths', async t => {
  const { s, pending, dir } = setup(t, false);
  s.beginBootCliPathProbes();
  const boot = await s.readConfig();
  assert.equal(boot.claudePath, ''); assert.equal(boot.kimiPath, '');
  s.finishBootCliPathProbes();
  pending[0].resolve('found-claude.exe'); pending[1].resolve('found-kimi.exe');
  const config = await s.readConfig();
  assert.equal(config.claudePath, 'found-claude.exe'); assert.equal(config.kimiPath, 'found-kimi.exe');
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'data/config.json'), 'utf8'));
  assert.equal(Object.hasOwn(disk, 'claudePath'), false); assert.equal(Object.hasOwn(disk, 'kimiPath'), false);
});

test('configured batch launcher waits for actual async executable verification and keeps original disk spelling', { skip: process.platform !== 'win32' }, async t => {
  const { s, pending, dir } = setup(t);
  const file = path.join(dir, 'data/config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.claudePath = 'configured-claude.cmd';
  fs.writeFileSync(file, JSON.stringify(raw));
  const check = s.__eval(`(() => {
    const state = { calls: 0, resolve: null };
    claudeShimExeFor = () => 'verified-claude.exe';
    spawnProbeAsync = (exe, args) => { state.calls++; if (exe !== 'verified-claude.exe' || args[0] !== '--version') throw Error('Wrong verification'); return new Promise(resolve => { state.resolve = resolve; }); };
    return state;
  })()`);
  s.beginBootCliPathProbes();
  const boot = await s.readConfig();
  assert.equal(boot.claudePath, 'configured-claude.cmd'); assert.equal(check.calls, 1);
  s.finishBootCliPathProbes();
  pending[0].resolve('found-claude.exe'); pending[1].resolve('found-kimi.exe');
  let settled = false;
  const api = s.readConfig().then(c => { settled = true; return c; });
  await tick(); assert.equal(settled, false);
  check.resolve({ error: null, status: 0 });
  assert.equal((await api).claudePath, 'verified-claude.exe');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).claudePath, 'configured-claude.cmd');
});

test('probe invalidation prevents outstanding startup discoveries from overwriting the new generation', async t => {
  const { s, pending } = setup(t);
  s.beginBootCliPathProbes(); await tick();
  s.invalidateClaudePathCache(); s.finishBootCliPathProbes();
  pending[0].resolve('stale-claude.exe'); pending[1].resolve('stale-kimi.exe');
  await tick();
  assert.equal(s.__eval('_claudePathProbe'), null);
  assert.equal(s.__eval("_agentCliPathProbe.has('kimi')"), false);
  assert.equal(s.__eval('bootCliPathProbes.pending.size'), 0);
});

test('post-listen config waits for a verification job queued after the initial pending snapshot', async t => {
  const { s, pending } = setup(t);
  s.beginBootCliPathProbes(); await tick(); s.finishBootCliPathProbes();
  let settled = false;
  const api = s.readConfig().then(config => { settled = true; return config; });
  const release = s.__eval(`(() => {
    let release;
    queueBootCliPathProbe(() => new Promise(resolve => { release = resolve; }));
    return () => release();
  })()`);
  await tick();
  pending[0].resolve('found-claude.exe'); pending[1].resolve('found-kimi.exe');
  await tick(); assert.equal(settled, false);
  release();
  assert.equal((await api).claudePath, 'configured-claude.exe');
});

test('failed shim verification preserves the configured fallback and missing discoveries remain empty', { skip: process.platform !== 'win32' }, async t => {
  const { s, pending, dir } = setup(t);
  const file = path.join(dir, 'data/config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.claudePath = 'configured-claude.cmd';
  fs.writeFileSync(file, JSON.stringify(raw));
  s.__eval("claudeShimExeFor = () => 'broken-claude.exe'; spawnProbeAsync = async () => ({ error: new Error('synthetic missing executable'), status: null });");
  s.beginBootCliPathProbes(); await s.readConfig(); s.finishBootCliPathProbes();
  pending[0].resolve(''); pending[1].resolve('');
  const config = await s.readConfig();
  assert.equal(config.claudePath, 'configured-claude.cmd');
  assert.equal(s.detectClaudePath(), ''); assert.equal(s.detectKimiPath(), '');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).claudePath, 'configured-claude.cmd');
});
