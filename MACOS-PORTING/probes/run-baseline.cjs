#!/usr/bin/env node
'use strict';
// P0 evidence collector. Uses existing tests unchanged; failures are recorded, never waived.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const harness = path.join(root, 'dev-harness');
const { fixtureChildEnv, GUARD_FILE } = require(path.join(harness, 'lib/fixture-home'));
const { killOwnTree } = require(path.join(harness, 'lib/kill-own-tree'));
const units = ['provider-wire-protocols', 'provider-wire-anthropic', 'scheduler-core',
  'credential-vault', 'permission-resolve', 'file-tools-core', 'server-ownership',
  'win-cmdline-quote', 'agent-cli-adapters', 'workspace-trailing-sep'];
const ciSmoke = ['provider-custom-headers', 'git', 'scheduler-api', 'mcp-bridge'];
const auditSmoke = [...ciSmoke, 'file-guard', 'anthropic-fake', 'kimi-agent-cli',
  'agent-role-openai', 'checkpoint', 'workbench-memory', 'provider-compact'];
function options(argv) {
  const out = { profile: 'ci', section: 'all', output: path.join(root, 'MACOS-PORTING/evidence/P0/local') };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!['profile', 'section', 'output'].includes(key) || !argv[i + 1]) throw new Error('Expected --profile ci|audit --section all|gates|unit|static|smoke --output DIRECTORY');
    out[key] = argv[i + 1];
  }
  if (!['ci', 'audit'].includes(out.profile) || !['all', 'gates', 'unit', 'static', 'smoke'].includes(out.section)) throw new Error('Unknown profile or section');
  return out;
}
const active = new Set();
function stop(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') killOwnTree(child);
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* only our detached test group */ } }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { for (const child of active) stop(child); process.exit(130); });
async function run(item, directory) {
  const started = Date.now();
  const fixture = fixtureChildEnv({ perTest: true });
  // Cases own their data roots; injecting RUYI_HOME overrides legacy-only fixtures.
  delete fixture.env.RUYI_HOME;
  delete fixture.env.WIN_CLAUDE_WORKBENCH_HOME;
  // Unique short temp root avoids fixed fixture paths and stale Unix sockets between runs.
  // This changes test isolation only; the application ownership/cleanup behavior is unchanged.
  const fixtureTmp = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'ruyi-p0-'));
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) fixture.env[key] = fixtureTmp;
  const log = path.join(directory, item.id + '.txt');
  const fd = fs.openSync(log, 'w');
  // Explicit file descriptors avoid output-buffer truncation or an orphan holding a pipe open.
  const child = cp.spawn(process.execPath, ['--require', GUARD_FILE, ...item.args], {
    cwd: root, env: fixture.env, windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  active.add(child);
  let timedOut = false, spawnError = '';
  const timer = setTimeout(() => { timedOut = true; stop(child); }, item.timeout || 120000);
  return new Promise(resolve => {
    child.on('error', error => { spawnError = error.code || 'spawn_error'; });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (process.platform !== 'win32') stop(child);
      active.delete(child);
      const ok = code === 0 && !timedOut && !spawnError;
      const result = { id: item.id, nodeArgs: item.args, status: ok ? 'pass' : 'fail', exitCode: code, signal,
        timedOut, spawnError, elapsedMs: Date.now() - started, log: path.basename(log) };
      if (ok) {
        for (const directory of [fixture.home, fixtureTmp]) {
          try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); }
          catch { result.cleanupWarning = 'Fixture directory retained'; }
        }
      } else { result.fixtureHome = fixture.home; result.fixtureTmp = fixtureTmp; }
      console.log(`${result.status.toUpperCase()} ${item.id} (${result.elapsedMs}ms)`);
      resolve(result);
    });
  });
}
async function main() {
  const opt = options(process.argv.slice(2));
  const output = path.resolve(opt.output);
  fs.mkdirSync(output, { recursive: true });
  const allUnits = fs.readdirSync(path.join(harness, 'unit')).filter(n => n.endsWith('.test.js')).sort();
  const staticFiles = fs.readdirSync(harness).filter(n => n.endsWith('.static.e2e.js')).sort();
  const allE2e = fs.readdirSync(harness).filter(n => n.endsWith('.e2e.js')).sort();
  const selectedUnits = opt.profile === 'ci' ? units.map(n => n + '.test.js') : allUnits;
  const plan = [];
  const include = name => opt.section === 'all' || opt.section === name;
  if (include('gates')) plan.push({ id: 'syntax', args: ['dev-harness/syntax-gate.js'] }, { id: 'build', args: ['ruyi-workbench/app/build.js', '--check'] });
  if (include('unit')) plan.push({ id: 'unit', timeout: 600000, args: ['--test', '--test-concurrency=4', '--test-reporter=tap', ...selectedUnits.map(n => 'dev-harness/unit/' + n)] });
  if (include('static')) for (const file of opt.profile === 'ci' ? ['prompt-snapshot.static.e2e.js'] : staticFiles) plan.push({ id: file, args: ['dev-harness/' + file] });
  if (include('smoke')) for (const name of opt.profile === 'ci' ? ciSmoke : auditSmoke) plan.push({ id: name + '.e2e.js', args: ['dev-harness/' + name + '.e2e.js'] });
  const sha = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const selectedE2e = plan.filter(t => t.id.endsWith('.e2e.js')).map(t => t.id);
  const report = { schema: 1, profile: opt.profile, section: opt.section, startedAt: new Date().toISOString(),
    baselineSha: sha, platform: process.platform, arch: process.arch, osRelease: os.release(), node: process.version,
    unitFiles: include('unit') ? selectedUnits : [],
    notSelectedE2e: allE2e.filter(n => !selectedE2e.includes(n)),
    scope: 'Existing tests unchanged. notSelected is not pass/skip. Windows-only skips inside unit TAP remain visible.', results: [] };
  const reportPath = path.join(output, 'report.json');
  for (const item of plan) {
    report.results.push(await run(item, output));
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  report.finishedAt = new Date().toISOString();
  report.summary = { pass: report.results.filter(r => r.status === 'pass').length, fail: report.results.filter(r => r.status === 'fail').length };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.summary.fail ? 1 : 0;
}
main().catch(error => { for (const child of active) stop(child); console.error(error); process.exitCode = 1; });
