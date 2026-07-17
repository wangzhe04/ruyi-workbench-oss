(async () => {
// E2E (PF2 「性能专项」): session metadata index (sessions/index.json). Offline, zero-dep.
// Spawns fake-openai + workbench; drives session CRUD over HTTP and pokes the on-disk index.json to prove the
// index is ONLY a cache and the per-session files stay authoritative. Ports 9135 (fake) + 9136 (wb).
//
// Asserts:
//  ① after listing, sessions/index.json exists and its id-set + fields MATCH the real session files.
//  ② running a turn / PATCHing meta keeps the index current (messageCount + title track saveSession).
//  ③ DELETE index.json → GET /api/sessions still returns the right sessions (fallback scan) AND rebuilds it.
//  ④ CORRUPT index.json (garbage, and valid-json-wrong-shape) → list never 500s, returns truth, rebuilds.
//  ⑤ DRIFT: a session file created directly on disk (id-set mismatch) → list detects it and scans (includes it).
//  ⑥ DELETE a session over HTTP → index drops it; list stays correct.
// Judgement line (exact): SESSION-INDEX E2E: ALL PASS
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-session-index-e2e');
const SESSDIR = path.join(HOME, 'sessions');
const IDX = path.join(SESSDIR, 'index.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p, headers) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000, headers: headers || {} }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    r.on('error', () => resolve({ status: 0, json: null, raw: '' })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '' }); });
  });
}
function reqJson(port, method, p, payload, headers) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 6000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    req.on('error', () => resolve({ status: 0, json: null, raw: '' })); req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, raw: '' }); });
    req.write(data); req.end();
  });
}
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 15000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; res.on('data', c => { buf += c; }); res.on('end', () => resolve(buf));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); }); req.write(data); req.end();
  });
}
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

// Read the on-disk index (array) or null. Read the truth from the actual session files (the 7 meta fields).
function readIndexFile() { try { const a = JSON.parse(fs.readFileSync(IDX, 'utf8')); return Array.isArray(a) ? a : null; } catch { return null; } }
function truthFromFiles() {
  const out = [];
  for (const f of fs.readdirSync(SESSDIR).filter(f => f.endsWith('.json') && f !== 'index.json')) {
    try { const s = JSON.parse(fs.readFileSync(path.join(SESSDIR, f), 'utf8')); out.push({ id: s.id, title: s.title, messageCount: (s.messages || []).length, updatedAt: s.updatedAt }); } catch { /* skip */ }
  }
  return out;
}
const byId = arr => new Map((arr || []).map(e => [String(e.id), e]));

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
    activeProvider: 'fake',
  }, null, 2));

  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT) }, windowsHide: true });
  fake.stdout.on('data', () => {});
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  let wb2 = null; // PF2 ⑧: a second (restarted) instance, killed in finally

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    const hdr = { 'x-wcw-token': token };

    // Create 3 sessions.
    const ids = [];
    for (const t of ['Alpha', 'Beta', 'Gamma']) {
      const r = await reqJson(WB_PORT, 'POST', '/api/sessions', { title: t, cwd: HOME }, hdr);
      ids.push(r.json && r.json.session && r.json.session.id);
    }
    ok(ids.every(Boolean) && new Set(ids).size === 3, 'three sessions created');

    // ── ① list builds an index that matches the real files ──────────────────────────────────────────────
    const l1 = await getJson(WB_PORT, '/api/sessions', hdr);
    ok(l1.status === 200 && l1.json && l1.json.ok && l1.json.sessions.length === 3, '① GET /api/sessions → 3 sessions');
    await sleep(50);
    const idx1 = readIndexFile();
    ok(Array.isArray(idx1) && idx1.length === 3, '① sessions/index.json written with 3 entries');
    const idxMap = byId(idx1), truthMap = byId(truthFromFiles());
    ok([...truthMap.keys()].every(id => idxMap.has(id)) && idxMap.size === truthMap.size, '① index id-set == real session files');
    ok([...truthMap.entries()].every(([id, t]) => idxMap.get(id) && idxMap.get(id).title === t.title), '① index titles match the real files');

    // ── ② running a turn keeps messageCount in the index current ────────────────────────────────────────
    await postStream(WB_PORT, { sessionId: ids[0], message: '你好', cwd: HOME });
    await sleep(500); // PF2 index write is debounced (~200ms) + coalesced; wait past the flush window before the fast-path read
    const l2 = await getJson(WB_PORT, '/api/sessions', hdr);
    const s0 = l2.json.sessions.find(s => s.id === ids[0]);
    const fileCount0 = truthFromFiles().find(t => t.id === ids[0]).messageCount;
    ok(s0 && s0.messageCount === fileCount0 && fileCount0 >= 2, '② after a turn, list messageCount == file (' + fileCount0 + ')');
    ok(byId(readIndexFile()).get(ids[0]).messageCount === fileCount0, '② index.json messageCount updated by saveSession');

    // ── ② PATCH meta (title + pinned) flows into the index ──────────────────────────────────────────────
    await reqJson(WB_PORT, 'PATCH', '/api/sessions/' + ids[1], { title: 'Beta-Renamed', pinned: true }, hdr);
    await sleep(500); // debounced index write (id-set unchanged → fast path won't rebuild); wait past the ~200ms flush window
    const l3 = await getJson(WB_PORT, '/api/sessions', hdr);
    const s1 = l3.json.sessions.find(s => s.id === ids[1]);
    ok(s1 && s1.title === 'Beta-Renamed' && s1.pinned === true, '② PATCH title/pinned reflected in list');
    ok(byId(readIndexFile()).get(ids[1]).title === 'Beta-Renamed', '② index.json reflects the PATCHed title');
    ok(l3.json.sessions[0].id === ids[1], '② pinned session sorts first');

    // ── ⑦ PF2 FIX (no dirty read): a read landing INSIDE the ~200ms debounce window must be fresh. PATCH a
    //     title and read the list IMMEDIATELY (no sleep) — the merge of the pending batch makes the new value
    //     visible at once, even though the on-disk index.json hasn't been flushed yet. Pre-fix, the fast path
    //     served the STALE on-disk title for up to ~200ms after every save.
    const freshTitle = 'Alpha-Immediate-' + Date.now();
    await reqJson(WB_PORT, 'PATCH', '/api/sessions/' + ids[0], { title: freshTitle }, hdr);
    const lImm = await getJson(WB_PORT, '/api/sessions', hdr); // NO sleep — deliberately inside the debounce window
    const sImm = lImm.json.sessions.find(s => s.id === ids[0]);
    ok(sImm && sImm.title === freshTitle, '⑦ immediate list shows the new title (merge closes the ~200ms dirty-read window)');
    const diskImm = byId(readIndexFile()).get(ids[0]);
    ok(diskImm && diskImm.title !== freshTitle, '⑦ on-disk index.json still stale at that instant → fresh value came from the pending merge, not disk');
    await sleep(300); // now let the debounced flush run
    ok(byId(readIndexFile()).get(ids[0]).title === freshTitle, '⑦ on-disk index converges to the new title after the flush');

    // ── ③ DELETE index.json → list still correct (fallback scan) + index rebuilt ────────────────────────
    fs.rmSync(IDX, { force: true });
    ok(!fs.existsSync(IDX), '③ index.json removed from disk');
    const l4 = await getJson(WB_PORT, '/api/sessions', hdr);
    ok(l4.status === 200 && l4.json.sessions.length === 3, '③ list still returns 3 with NO index (fallback to file scan)');
    ok(l4.json.sessions.find(s => s.id === ids[1]).title === 'Beta-Renamed', '③ fallback scan preserves correct fields');
    await sleep(50);
    ok(Array.isArray(readIndexFile()) && readIndexFile().length === 3, '③ index.json rebuilt after the fallback scan');

    // ── ④ CORRUPT index.json → list never 500s, returns truth, rebuilds ────────────────────────────────
    fs.writeFileSync(IDX, '{ this is not valid json ');
    const l5 = await getJson(WB_PORT, '/api/sessions', hdr);
    ok(l5.status === 200 && l5.json.sessions.length === 3, '④ garbage index → list still 200 with 3 (no crash)');
    // valid JSON but wrong shape (object, not array of entries).
    fs.writeFileSync(IDX, JSON.stringify({ not: 'an array' }));
    const l6 = await getJson(WB_PORT, '/api/sessions', hdr);
    ok(l6.status === 200 && l6.json.sessions.length === 3, '④ wrong-shape index → list still 200 with 3');
    await sleep(50);
    ok(Array.isArray(readIndexFile()) && readIndexFile().length === 3, '④ index.json rebuilt to a valid array');

    // ── ⑤ DRIFT: a session file created directly on disk (not via API) must be picked up ────────────────
    const manualId = 'sess_manualdrift01';
    fs.writeFileSync(path.join(SESSDIR, manualId + '.json'), JSON.stringify({
      id: manualId, schemaVersion: 1, turnSeq: 0, title: 'ManualDrift', summary: '', pinned: false,
      cwd: HOME, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [], providerHistory: [], attachments: [], todos: [],
    }, null, 2));
    const l7 = await getJson(WB_PORT, '/api/sessions', hdr);
    ok(l7.json.sessions.length === 4 && l7.json.sessions.some(s => s.id === manualId), '⑤ directly-added session file detected (id-set mismatch → scan)');
    await sleep(50);
    ok(byId(readIndexFile()).has(manualId), '⑤ index rebuilt to include the drifted session');

    // ── ⑥ DELETE a session over HTTP → index drops it ──────────────────────────────────────────────────
    await reqJson(WB_PORT, 'DELETE', '/api/sessions/' + ids[2], {}, hdr);
    await sleep(50);
    const l8 = await getJson(WB_PORT, '/api/sessions', hdr);
    ok(!l8.json.sessions.some(s => s.id === ids[2]), '⑥ deleted session gone from list'); // fast path merges the pending tombstone
    ok(!fs.existsSync(path.join(SESSDIR, ids[2] + '.json')), '⑥ session file unlinked');
    // PF2: the pending tombstone is applied to the LIST immediately (merge), but the on-disk index converges via
    // the debounced flush (~200ms). Wait past the flush window before asserting the persisted index dropped it.
    await sleep(300);
    ok(!byId(readIndexFile()).has(ids[2]), '⑥ deleted session gone from index.json (after the debounced flush)');

    // ── final consistency: index id-set == real files, both ways ────────────────────────────────────────
    const finalIdx = byId(readIndexFile()), finalTruth = byId(truthFromFiles());
    ok(finalIdx.size === finalTruth.size && [...finalTruth.keys()].every(id => finalIdx.has(id)), 'final index id-set == real session files (consistent)');

    // ── ⑧ PF2 FIX (crash self-heal): a hard crash can leave index.json STALE while its id-set still matches the
    //     session files — pre-fix, listSessions' fast path would trust that stale index forever. Simulate it:
    //     kill the server (no graceful flush), corrupt one title on disk WITHOUT changing the id-set, then
    //     restart. The boot-time invalidateSessionIndex() forces the first listSessions to rebuild from the
    //     authoritative session files, so the crash-stale title never surfaces.
    const fileTitle0 = JSON.parse(fs.readFileSync(path.join(SESSDIR, ids[0] + '.json'), 'utf8')).title; // truth
    killp(wb); await sleep(700); // hard stop — no exit handler flush (this is the "crash")
    const realIdx = readIndexFile();
    const staleIdx = realIdx.map(e => (String(e.id) === ids[0] ? { ...e, title: 'CRASH-STALE-TITLE' } : e)); // id-set unchanged
    fs.writeFileSync(IDX, JSON.stringify(staleIdx, null, 2));
    ok(byId(readIndexFile()).get(ids[0]).title === 'CRASH-STALE-TITLE', '⑧ planted a crash-stale index (id-set intact, one title wrong)');
    wb2 = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
    wb2.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb2!] ' + l.trim())));
    let h2 = null; for (let i = 0; i < 40 && !h2; i++) { await sleep(150); h2 = await health(WB_PORT); }
    ok(!!h2, '⑧ workbench restarted on :' + WB_PORT);
    const token2 = await getToken(WB_PORT);
    const lBoot = await getJson(WB_PORT, '/api/sessions', { 'x-wcw-token': token2 });
    const sBoot = lBoot.json && lBoot.json.sessions.find(s => s.id === ids[0]);
    ok(sBoot && sBoot.title === fileTitle0 && sBoot.title !== 'CRASH-STALE-TITLE',
       '⑧ after restart the boot rebuild heals the crash-stale title (got "' + (sBoot && sBoot.title) + '", file truth "' + fileTitle0 + '")');
    await sleep(50);
    ok(byId(readIndexFile()).get(ids[0]).title === fileTitle0, '⑧ index.json rebuilt from truth on boot (stale title gone)');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    killp(wb); killp(wb2); killp(fake);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nSESSION-INDEX E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
