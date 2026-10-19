'use strict';
require('./lib/self-isolate-home.js');
// Real serve/MCP processes: no mocked lock, health, or recovery path.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort, getFreePorts } = require('./free-port');
const { createRunner } = require('./lib/harness');
const { CONFIG_SCHEMA: CURRENT_CONFIG_SCHEMA } = require('../ruyi-workbench/app/server.js');
const t = createRunner('SERVER OWNERSHIP');
const { ok } = t;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-ownership-'));
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = process.env.RUYI_TEST_SERVER_JS || path.join(WB, 'app', 'server.js');
const children = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const envBase = fixtureChildEnv();
function data(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    configSchema: CURRENT_CONFIG_SCHEMA, permissionMode: 'bypass', stewardEnabledV1: false, schedulerEnabledV1: false,
    autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false, enableMcpDropIn: false,
    desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [], providers: [],
  }));
  return dir;
}
function spawn(root, port, command = 'serve', nodeArgs = [], extraEnv = {}) {
  const home = path.join(ROOT, 'user'); fs.mkdirSync(home, { recursive: true });
  const child = cp.spawn(process.execPath, [...nodeArgs, SERVER, command, ...(command === 'serve' ? ['--port', String(port)] : [])], {
    cwd: WB, windowsHide: true,
    // Keep runner injection; the fixture environment overrides user home and both AppData roots.
    env: { ...process.env, ...envBase, HOME: home, USERPROFILE: home, RUYI_HOME: root, WIN_CLAUDE_WORKBENCH_HOME: root, ...extraEnv },
  });
  child.output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { child.output = (child.output + chunk).slice(-16000); });
  child.completed = new Promise(resolve => child.once('close', code => resolve(code)));
  children.push(child);
  return child;
}
function request(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 500 }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(text)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
async function until(fn, budget = 15000) {
  const deadline = Date.now() + budget;
  do { const value = await fn(); if (value) return value; await sleep(50); } while (Date.now() < deadline);
  return null;
}
const runtime = root => { try { return JSON.parse(fs.readFileSync(path.join(root, 'runtime.json'), 'utf8')); } catch { return null; } };
async function ready(child, root) {
  const record = await until(() => { const r = runtime(root); return r && r.pid === child.pid ? r : null; });
  if (!record || !(await request(record.port))?.ok) throw new Error('serve failed: ' + child.output.slice(-1200));
  return record;
}
async function exited(child) {
  const code = await until(() => child.exitCode !== null ? { code: child.exitCode } : null);
  if (!code) throw new Error('child did not exit: ' + child.output.slice(-1200));
  await child.completed;
  return code.code;
}
async function stop(child) {
  if (child && child.exitCode === null) killOwnTree(child);
  if (child) await child.completed;
}
function pending(root) {
  const file = path.join(root, 'sessions', 'sess_ownership.interventions.ndjson');
  fs.writeFileSync(file, JSON.stringify({ id: 'lease_pending', sessionId: 'sess_ownership', type: 'permission',
    status: 'pending', requestedAt: new Date().toISOString(), toolName: 'Bash', interventionVersion: 0 }) + '\n');
  return file;
}
(async () => {
  try {
    const root = data('active');
    const [portA, portB] = await getFreePorts(2);
    const a = spawn(root, portA); const rtA = await ready(a, root);
    const pendingFile = pending(root);
    const beforePending = fs.readFileSync(pendingFile, 'utf8');
    const beforeRuntime = fs.readFileSync(path.join(root, 'runtime.json'), 'utf8');
    const b = spawn(root, portB);
    ok(await exited(b) === 1 && /DATA_ROOT_IN_USE|数据目录已有/.test(b.output), 'same root on a different port rejects the second serve');
    ok(fs.readFileSync(pendingFile, 'utf8') === beforePending, 'rejected startup does not cancel the live owner pending decision');
    ok(fs.readFileSync(path.join(root, 'runtime.json'), 'utf8') === beforeRuntime && !fs.existsSync(path.join(root, 'last-start-error.json')), 'refusal leaves owner handshake and startup notice unchanged');
    ok((await request(portA))?.overlayId === rtA.overlayId && a.exitCode === null, 'the first service remains alive with the same identity');

    const alias = path.join(ROOT, 'junction-alias'); fs.symlinkSync(root, alias, 'junction');
    const aliasChild = spawn(alias, await getFreePort());
    ok(await exited(aliasChild) === 1, 'junction alias resolves to the same OS gate');
    if (process.platform === 'win32') {
      const casing = spawn(root.toUpperCase(), await getFreePort());
      ok(await exited(casing) === 1, 'Windows case aliases resolve to the same OS gate');
    }

    const mcp = spawn(root, null, 'mcp');
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ownership-test', version: '1' } } }) + '\n');
    ok(await until(() => mcp.output.split(/\r?\n/).some(line => { try { const r = JSON.parse(line); return r.id === 1 && r.result?.serverInfo; } catch { return false; } })), 'legitimate MCP child can initialize beside the owning serve');
    await stop(mcp);
    ok(fs.readFileSync(pendingFile, 'utf8') === beforePending, 'MCP initialization does not perform serve recovery');

    // killOwnTree force-terminates our verified child; no graceful lease release is required.
    await stop(a);
    const restarted = spawn(root, await getFreePort()); await ready(restarted, root);
    ok(fs.readFileSync(pendingFile, 'utf8').includes('cancelled_restart'), 'after a real process crash a new owner acquires and reconciles the residual pending journal');
    await stop(restarted);

    const raceRoot = data('race'); const ports = await getFreePorts(2);
    const racers = [spawn(raceRoot, ports[0]), spawn(raceRoot, ports[1])];
    const winnerRecord = await until(() => runtime(raceRoot));
    const winner = racers.find(child => child.pid === winnerRecord?.pid);
    if (!winner) throw new Error('concurrent startup produced no owner');
    const loser = racers.find(child => child !== winner);
    await ready(winner, raceRoot);
    ok(await exited(loser) === 1 && winner.exitCode === null, 'simultaneous OS binds produce exactly one serving owner');
    await stop(winner);

    if (process.platform === 'win32' || (process.platform === 'linux' && Number(process.versions.node.split('.')[0]) >= 22)) {
      const exitRoot = data('exit-writes');
      const control = path.join(ROOT, 'exit-control');
      const inExit = path.join(ROOT, 'inside-exit');
      const finishExit = path.join(ROOT, 'finish-exit');
      const lateWrite = path.join(exitRoot, 'late-exit-write.txt');
      const preload = path.join(ROOT, 'exit-preload.js');
      fs.writeFileSync(preload, `const fs=require('fs');const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(control)}))return;clearInterval(timer);process.on('exit',()=>{fs.writeFileSync(${JSON.stringify(inExit)},'started');const end=Date.now()+15000;while(!fs.existsSync(${JSON.stringify(finishExit)})&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);fs.writeFileSync(${JSON.stringify(lateWrite)},'finished');});process.exit(0);},25);timer.unref();`);
      const exiting = spawn(exitRoot, await getFreePort(), 'serve', ['--require', preload]);
      await ready(exiting, exitRoot);
      fs.writeFileSync(control, 'exit');
      if (!await until(() => fs.existsSync(inExit))) throw new Error('exit fixture did not reach its final write');
      // Remove only this isolated fixture's legacy PID guard: the IPC gate itself must
      // still block recovery, rather than passing solely because runtime.pid is alive.
      fs.unlinkSync(path.join(exitRoot, 'runtime.json'));
      const duringExit = spawn(exitRoot, await getFreePort());
      await until(() => duringExit.exitCode !== null || runtime(exitRoot)?.pid === duringExit.pid);
      ok(duringExit.exitCode === 1 && !fs.existsSync(lateWrite), 'a second serve cannot acquire while the old process is still performing exit-time writes, even without the legacy PID guard');
      await stop(duringExit);
      fs.writeFileSync(finishExit, 'continue');
      await exiting.completed;
      ok(fs.readFileSync(lateWrite, 'utf8') === 'finished', 'the old process completes its exit write before ownership becomes available');
      const afterExit = spawn(exitRoot, await getFreePort()); await ready(afterExit, exitRoot);
      ok(afterExit.exitCode === null, 'ownership becomes available only after the writing process exits');
      await stop(afterExit);
    }

    const legacyRoot = data('legacy-live');
    const innocent = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, env: envBase });
    innocent.completed = new Promise(resolve => innocent.once('close', resolve)); children.push(innocent);
    const legacyRecord = JSON.stringify({ pid: innocent.pid, port: 1, overlayId: 'old-or-reused-pid' });
    fs.writeFileSync(path.join(legacyRoot, 'runtime.json'), legacyRecord);
    const legacyAttempt = spawn(legacyRoot, await getFreePort());
    ok(await exited(legacyAttempt) === 1 && innocent.exitCode === null, 'live legacy or reused PID is conservatively refused without killing the unrelated process');
    ok(fs.readFileSync(path.join(legacyRoot, 'runtime.json'), 'utf8') === legacyRecord, 'legacy refusal does not overwrite identity evidence');
    await stop(innocent);
    const recovered = spawn(legacyRoot, await getFreePort()); await ready(recovered, legacyRoot);
    ok(recovered.exitCode === null, 'a confirmed dead legacy PID permits startup');
    await stop(recovered);
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    for (const child of children) await stop(child);
    if (!t.failures) fs.rmSync(ROOT, { recursive: true, force: true });
    else console.log('[keep] ' + ROOT);
  }
  t.done({ exit: true });
})();
