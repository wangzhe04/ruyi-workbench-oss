// E2E (v0.8-S4a): checkpoint journal + rollback on the provider engine (fake-openai + /api/tools direct
// calls, offline). Covers:
//  (a) FAKE_TOOL_SEQUENCE=[file_write NEW a.txt, file_edit a.txt] in ONE turn →
//      GET /api/checkpoints shows TWO entries (create + modify); the modify entry has a .gz; turn_summary
//      filesChanged has the path revertible:true.
//  (b) POST rollback whole turn → a.txt no longer exists (create's inverse = delete); rolling the same
//      turn again → {ok:false, error:'no entries'} (idempotent).
//  (c) turn 2 file_write recreates a.txt (v2) + turn 3 file_edit (v3) → rolling back ONLY turn 3 restores
//      a.txt to the turn-2 version (each entry carries its own before; GC of old turns doesn't hurt this).
//  (d) file_delete via /api/tools direct → GET checkpoints has an op:delete entry → rollback → file
//      resurrected with identical content.
//  (e) POST rollback with NO UI token → 403.
// Token手法 copied from search-robust; direct tool calls carry sessionId so they journal under the session.
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-checkpoint-e2e');
const FAKE_PORT = 8975, WB_PORT = 8976;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p, headers) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000, headers: headers || {} }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { resolve({ status: resp.statusCode, body: JSON.parse(b) }); } catch (e) { reject(new Error('bad json: ' + b)); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
function postJson(port, p, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { reject(new Error('bad json: ' + b)); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
function tool(port, token, name, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port, path: '/api/tools/' + name, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-wcw-token': token } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b)); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
function writeConfig(home, fakePort) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
    activeProvider: 'fake',
  }, null, 2));
}
// Spawn a fake-openai bound to a specific FAKE_TOOL_SEQUENCE, run one chat turn, then kill the fake.
function spawnFake(seq) {
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_SEQUENCE: JSON.stringify(seq) }, windowsHide: true });
  fake.stdout.on('data', () => {});
  return fake;
}
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
// The fake-openai has no /health route; probe raw TCP connectivity instead. `fakeReachable` true once
// something accepts a connection on FAKE_PORT; false once the previous fake has fully released it.
function fakeReachable() { return new Promise(resolve => { const net = require('net'); const s = net.connect({ host: '127.0.0.1', port: FAKE_PORT }, () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); s.setTimeout(500, () => { s.destroy(); resolve(false); }); }); }
async function waitFakeUp() { for (let i = 0; i < 50; i++) { if (await fakeReachable()) return true; await sleep(100); } return false; }
async function waitFakeDown() { for (let i = 0; i < 50; i++) { if (!await fakeReachable()) return true; await sleep(100); } return false; }

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const target = path.join(HOME, 'a.txt');
  writeConfig(HOME, FAKE_PORT);
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  procs.push(wb);

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');

    const created = await postJson(WB_PORT, '/api/sessions', { title: 'checkpoint test', cwd: HOME });
    const sid = created.body.session && created.body.session.id;
    ok(!!sid, 'session created');

    // ============ (a) turn 1: file_write (create a.txt) then file_edit (modify) ============
    const fake1 = spawnFake([
      { name: 'file_write', args: { path: target, content: 'v1-created' } },
      { name: 'file_edit', args: { path: target, oldText: 'v1-created', newText: 'v1-edited' } },
    ]);
    procs.push(fake1);
    ok(await waitFakeUp(), '(a) fake-openai listening on :' + FAKE_PORT);
    const ev1 = await postStream(WB_PORT, { sessionId: sid, message: 'do work', cwd: HOME });
    killp(fake1); await waitFakeDown();
    ok(fs.existsSync(target) && fs.readFileSync(target, 'utf8') === 'v1-edited', '(a) a.txt exists with edited content after turn 1');

    const cp1 = (await getJson(WB_PORT, '/api/checkpoints?sessionId=' + sid, { 'x-wcw-token': token })).body;
    ok(cp1.ok && Array.isArray(cp1.entries), '(a) GET /api/checkpoints ok');
    const t1entries = cp1.entries.filter(e => e.turnSeq === 1);
    ok(t1entries.length === 2, '(a) turn 1 has TWO checkpoint entries (got ' + t1entries.length + ')');
    ok(t1entries.some(e => e.op === 'create' && e.tool === 'file_write' && e.path === target), '(a) has a create entry for a.txt');
    const modEntry = t1entries.find(e => e.op === 'modify' && e.tool === 'file_edit');
    ok(!!modEntry, '(a) has a modify entry (file_edit)');
    // The modify entry must have a .gz on disk (before content stored); create must NOT.
    const gzPath = path.join(HOME, 'checkpoints', sid, `${modEntry.turnSeq}-${modEntry.entrySeq}.gz`);
    ok(fs.existsSync(gzPath), '(a) modify entry has a .gz on disk');
    const createEntry = t1entries.find(e => e.op === 'create');
    ok(!fs.existsSync(path.join(HOME, 'checkpoints', sid, `${createEntry.turnSeq}-${createEntry.entrySeq}.gz`)), '(a) create entry has NO .gz (no before)');

    const ts1 = ev1.find(e => e.type === 'turn_summary');
    ok(ts1 && Array.isArray(ts1.filesChanged), '(a) turn_summary emitted');
    const fc = ts1 && ts1.filesChanged.find(f => f.path === target);
    ok(fc && fc.revertible === true, '(a) turn_summary filesChanged for a.txt is revertible:true');
    // Journal overlay collapses to one entry per path; op reflects the LAST journal write (modify).
    ok(ts1 && ts1.filesChanged.filter(f => f.path === target).length === 1, '(a) one filesChanged row per path (merged)');

    // ============ (b) rollback the whole turn 1 → a.txt gone; re-rollback → no entries ============
    const rb1 = (await postJson(WB_PORT, '/api/checkpoints/rollback', { sessionId: sid, turnSeq: 1 }, { 'x-wcw-token': token })).body;
    ok(rb1.ok === true && Array.isArray(rb1.reverted), '(b) rollback turn 1 ok');
    ok(!fs.existsSync(target), '(b) a.txt removed (create inverse = delete) after whole-turn rollback');
    ok(rb1.reverted.some(r => r.op === 'create'), '(b) reverted list includes the create op');
    const rb1b = (await postJson(WB_PORT, '/api/checkpoints/rollback', { sessionId: sid, turnSeq: 1 }, { 'x-wcw-token': token })).body;
    ok(rb1b.ok === false && rb1b.error?.code === 'api.request_failed' && rb1b.error?.message === 'no entries', '(b) re-rolling turn 1 returns the structured idempotency error');

    // ============ (c) turn 2 recreate (v2), turn 3 edit (v3); roll back only turn 3 → v2 restored ============
    // Driven via /api/tools direct calls with an EXPLICIT turnSeq (the spec's "fake-openai + /api/tools 直
    //调混合"): file_write pinned to turnSeq 2 recreates a.txt (create), file_edit pinned to turnSeq 3
    // rewrites it (modify). Two independent turns in ONE session — each entry carries its own before, so
    // rolling back turn 3 must land on the turn-2 content even though turn 1's checkpoints were rolled back.
    const w2 = (await tool(WB_PORT, token, 'file_write', { path: target, content: 'v2-recreated', sessionId: sid, turnSeq: 2 })).result;
    ok(w2 && w2.ok === true && w2.op === 'create', '(c) turn 2 file_write recreated a.txt (op:create)');
    ok(fs.readFileSync(target, 'utf8') === 'v2-recreated', '(c) turn 2 recreated a.txt = v2-recreated');

    const e3 = (await tool(WB_PORT, token, 'file_edit', { path: target, oldText: 'v2-recreated', newText: 'v3-edited', sessionId: sid, turnSeq: 3 })).result;
    ok(e3 && e3.ok === true, '(c) turn 3 file_edit applied');
    ok(fs.readFileSync(target, 'utf8') === 'v3-edited', '(c) turn 3 edited a.txt = v3-edited');

    // Confirm the journal holds turn-2 (create) and turn-3 (modify) entries independently.
    const cpC = (await getJson(WB_PORT, '/api/checkpoints?sessionId=' + sid, { 'x-wcw-token': token })).body;
    ok(cpC.entries.some(e => e.turnSeq === 2 && e.op === 'create'), '(c) journal has turn-2 create entry');
    ok(cpC.entries.some(e => e.turnSeq === 3 && e.op === 'modify'), '(c) journal has turn-3 modify entry');

    const rb3 = (await postJson(WB_PORT, '/api/checkpoints/rollback', { sessionId: sid, turnSeq: 3 }, { 'x-wcw-token': token })).body;
    ok(rb3.ok === true, '(c) rollback turn 3 ok');
    ok(fs.readFileSync(target, 'utf8') === 'v2-recreated', '(c) after rolling back turn 3, a.txt content = the turn-2 version (v2-recreated)');

    // ============ (d) file_delete via /api/tools direct → op:delete entry → rollback resurrects ============
    // Use a fresh file so we don't tangle with a.txt's history. Direct call carries sessionId to journal.
    const delTarget = path.join(HOME, 'del.txt');
    fs.writeFileSync(delTarget, 'delete-me-content');
    const before = (await getJson(WB_PORT, '/api/sessions/' + sid)).body.session.turnSeq;
    const delRes = (await tool(WB_PORT, token, 'file_delete', { path: delTarget, sessionId: sid })).result;
    ok(delRes && delRes.ok === true && delRes.op === 'delete', '(d) file_delete returned op:delete');
    ok(!fs.existsSync(delTarget), '(d) del.txt is gone after file_delete');
    const cpD = (await getJson(WB_PORT, '/api/checkpoints?sessionId=' + sid, { 'x-wcw-token': token })).body;
    const delEntry = cpD.entries.find(e => e.op === 'delete' && e.path === delTarget);
    ok(!!delEntry, '(d) GET checkpoints has an op:delete entry for del.txt');
    const rbD = (await postJson(WB_PORT, '/api/checkpoints/rollback', { sessionId: sid, turnSeq: delEntry.turnSeq, entrySeq: delEntry.entrySeq }, { 'x-wcw-token': token })).body;
    ok(rbD.ok === true, '(d) rollback of the delete entry ok');
    ok(fs.existsSync(delTarget) && fs.readFileSync(delTarget, 'utf8') === 'delete-me-content', '(d) del.txt resurrected with identical content');

    // ============ (e) rollback with NO token → 403 ============
    const noTok = await postJson(WB_PORT, '/api/checkpoints/rollback', { sessionId: sid, turnSeq: 1 });
    ok(noTok.status === 403, '(e) rollback without UI token → 403 (got ' + noTok.status + ')');
    ok(noTok.body && noTok.body.ok === false, '(e) 403 body ok:false');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) killp(c);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nCHECKPOINT E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();
