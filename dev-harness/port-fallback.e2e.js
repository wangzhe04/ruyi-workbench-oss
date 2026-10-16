'use strict';
require('./lib/self-isolate-home.js');
// 62 supersedes the old kill-A takeover contract: same-root B must refuse;
// different-root services and unrelated port occupants are left alive, with port fallback.
const { killOwnTree } = require('./lib/kill-own-tree');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { getFreePort } = require('./free-port');
const { createRunner } = require('./lib/harness');
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { CONFIG_SCHEMA: CURRENT_CONFIG_SCHEMA } = require('../ruyi-workbench/app/server.js');
const t = createRunner('PORT-FALLBACK');
const { ok } = t;
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-porttest-'));
const baseEnv = fixtureChildEnv();
const children = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function spawn(root, port) {
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(path.join(root, 'config.json'))) fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ configSchema: CURRENT_CONFIG_SCHEMA, autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false, desktopMcp: { enabled: false, autodetect: false } }));
  const child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
    // Retain runner-injected environment, then override every user location with the fixture home.
    cwd: WB, windowsHide: true, env: { ...process.env, ...baseEnv, RUYI_HOME: root, WIN_CLAUDE_WORKBENCH_HOME: root },
  });
  child.output = ''; for (const s of [child.stdout, child.stderr]) s.on('data', d => { child.output = (child.output + d).slice(-8000); });
  child.completed = new Promise(resolve => child.once('close', resolve));
  children.push(child); return child;
}
function health(port, json = true) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 600 }, res => {
      let body = ''; res.on('data', d => { body += d; });
      res.on('end', () => { try { resolve(json ? JSON.parse(body) : body); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
async function until(fn) { for (let i = 0; i < 200; i++) { const r = await fn(); if (r) return r; await sleep(50); } return null; }
async function ready(child, root) {
  const r = await until(() => { try { const rt = JSON.parse(fs.readFileSync(path.join(root, 'runtime.json'), 'utf8')); return rt.pid === child.pid ? rt : null; } catch { return null; } });
  if (!r) throw new Error('not ready: ' + child.output.slice(-1000));
  return r;
}
(async () => {
  try {
    const rootA = path.join(ROOT, 'a'); const port = await getFreePort();
    const a = spawn(rootA, port); await ready(a, rootA); const first = await health(port);
    ok(first?.ok, 'A serves the requested port');
    const b = spawn(rootA, port);
    ok(await until(() => b.exitCode !== null) !== null && b.exitCode === 1, 'same-root B exits with an explicit refusal, replacing the old kill-A contract');
    ok(a.exitCode === null && (await health(port))?.overlayId === first.overlayId, 'A stays alive and keeps serving its original identity');
    const cRoot = path.join(ROOT, 'different-root'); const c = spawn(cRoot, port); const rtC = await ready(c, cRoot);
    ok(rtC.port > port && rtC.port <= port + 9 && (await health(rtC.port))?.ok, 'another data root uses a fallback port and serves normally');
    ok(a.exitCode === null && (await health(port))?.overlayId === first.overlayId, 'a different-root workbench never kills the original workbench');

    const innocent = cp.spawn(process.execPath, ['-e', 'const h=require("http").createServer((q,s)=>s.end("hello"));h.listen(0,"127.0.0.1",()=>console.log(h.address().port));'], { windowsHide: true, env: baseEnv });
    innocent.completed = new Promise(resolve => innocent.once('close', resolve)); children.push(innocent);
    let innocentPort = 0; innocent.stdout.on('data', d => { innocentPort = Number(String(d).trim()); });
    if (!await until(() => innocentPort)) throw new Error('innocent service failed to listen');
    ok(await health(innocentPort, false) === 'hello', 'unrelated node service owns its port');
    const otherRoot = path.join(ROOT, 'innocent-case'); const other = spawn(otherRoot, innocentPort); const rtOther = await ready(other, otherRoot);
    ok(rtOther.port > innocentPort && rtOther.port <= innocentPort + 9 && (await health(rtOther.port))?.ok, 'workbench uses a fallback port beside an unrelated service');
    ok(innocent.exitCode === null, 'the unrelated process is still alive');
    ok(await health(innocentPort, false) === 'hello', 'the original port still serves the unrelated application');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    for (const child of children) { if (child.exitCode === null) killOwnTree(child); await child.completed; }
    if (!t.failures) fs.rmSync(ROOT, { recursive: true, force: true }); else console.log('[keep] ' + ROOT);
  }
  t.done({ exit: true });
})();
