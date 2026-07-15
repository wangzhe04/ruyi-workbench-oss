// E2E: safe bulk history cleanup. It proves the endpoint clears only unpinned, non-current chats
// and, when requested, purges the per-session checkpoint / Agent-run directories as well.
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const PORT = 8971;
const HOME = path.join(os.tmpdir(), 'ruyi-session-bulk-cleanup-e2e');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function kill(child) { if (child?.pid) try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function request(method, pathname, body, headers = {}) {
  return new Promise(resolve => {
    const text = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, timeout: 5000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers } }, res => {
      let raw = ''; res.on('data', part => { raw += part; }); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on('error', () => resolve({ status: 0, body: null })); req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.end(text);
  });
}
function get(pathname, headers = {}) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, timeout: 3000, headers }, res => { let raw = ''; res.on('data', p => { raw += p; }); res.on('end', () => resolve({ status: res.statusCode, raw })); });
    req.on('error', () => resolve({ status: 0, raw: '' })); req.on('timeout', () => { req.destroy(); resolve({ status: 0, raw: '' }); });
  });
}
function auxiliary(id) {
  for (const dir of [path.join(HOME, 'checkpoints', id), path.join(HOME, 'agent-runs', id)]) {
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'fixture.txt'), 'fixture');
  }
}

(async () => {
  let failures = 0; let server;
  const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { failures++; console.log('FAIL ' + label); } };
  try {
    fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
    server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME }, windowsHide: true });
    let healthy = false;
    for (let i = 0; i < 40 && !healthy; i++) { await sleep(125); healthy = (await get('/health')).status === 200; }
    ok(healthy, 'workbench started');
    const landing = await get('/'); const token = (landing.raw.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1]; const headers = { 'x-wcw-token': token };
    const create = async title => { const r = await request('POST', '/api/sessions', { title, cwd: HOME }, headers); return r.body?.session?.id; };
    const current = await create('Current'); const oldA = await create('Old A'); const oldB = await create('Old B'); const pinned = await create('Pinned');
    ok([current, oldA, oldB, pinned].every(Boolean), 'created four chats');
    await request('PATCH', '/api/sessions/' + pinned, { pinned: true }, headers);
    auxiliary(oldA); auxiliary(oldB);
    const cleanup = await request('POST', '/api/sessions/bulk-delete', { preserveSessionId: current, purgeAssociated: true }, headers);
    ok(cleanup.status === 200 && cleanup.body?.ok, 'bulk cleanup succeeds');
    ok(cleanup.body?.deletedCount === 2 && cleanup.body.deleted.includes(oldA) && cleanup.body.deleted.includes(oldB), 'only old unpinned chats are deleted');
    ok(cleanup.body?.skipped?.preserved === 1 && cleanup.body?.skipped?.pinned === 1, 'current and pinned chats are protected');
    const listedRaw = await get('/api/sessions', headers); let listed = null; try { listed = JSON.parse(listedRaw.raw); } catch {}
    const remaining = new Set((listed?.sessions || []).map(s => s.id));
    ok(remaining.size === 2 && remaining.has(current) && remaining.has(pinned), 'sidebar list retains only current and pinned chats');
    ok(!fs.existsSync(path.join(HOME, 'sessions', oldA + '.json')) && !fs.existsSync(path.join(HOME, 'sessions', oldB + '.json')), 'primary chat records removed');
    ok(!fs.existsSync(path.join(HOME, 'checkpoints', oldA)) && !fs.existsSync(path.join(HOME, 'agent-runs', oldB)), 'associated recovery and workflow records purged');
    const noOp = await request('POST', '/api/sessions/bulk-delete', { preserveSessionId: current, purgeAssociated: true }, headers);
    ok(noOp.body?.ok && noOp.body?.deletedCount === 0, 'repeat cleanup is a safe no-op');
  } catch (error) { failures++; console.log('ERROR ' + (error?.stack || error)); }
  finally { kill(server); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true }); console.log('\nSESSION-BULK-CLEANUP E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS')); process.exit(failures ? 1 : 0); }
})();
