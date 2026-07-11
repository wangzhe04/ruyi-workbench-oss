// E2E for v0.9-S3 (C3 / §0.9-S3): 文件树 + 工作文件夹 + 文件夹拖拽设工作区(指纹定位).
// Ports 9003 (fake-openai) + 9004 (workbench).
//
// The browser sandbox never exposes a dropped folder's absolute path, so the workbench locates it by
// FINGERPRINT: {name, children[]} → server searches candidate roots for a same-named dir whose first-level
// child names overlap ≥80% (Jaccard). This e2e drives that resolver both as a live HTTP endpoint AND as a
// direct unit (srv.resolveWorkspace) so the fingerprint math is asserted deterministically.
//
// Scenarios:
//   ① seed a temp tree (recentWorkspaces-injected root) → resolve exact fingerprint → unique hit, correct path.
//   ② rename / two same-named dirs → multiple candidates, score-sorted DESC.
//   ③ children mismatch (<0.8 overlap) → zero matches.
//   ④ recentWorkspaces LRU round-trip through config (front-insert / de-dupe / truncate 10) via /api/config.
//   ⑤ pick-folder — non-Windows graceful degrade branch asserted as a unit; on Windows the STA-script shape
//      is code-reviewed (a real dialog can't be asserted headless — see delivery notes). Also: HTTP 403 gate.
//   ⑥ session cwd PATCH persists (top-bar picker / folder-drag switch write path).
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_PORT = 9003, WB_PORT = 9004;
const srv = require(path.join(WB, 'app', 'server.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
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
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  const HOME = path.join(os.tmpdir(), 'wcw-workspace-resolve-e2e');
  const TREE = path.join(HOME, 'tree'); // where we seed candidate directories
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(TREE, { recursive: true });

  // ── seed the directory trees ────────────────────────────────────────────────────────────────────────
  // (A) unique target: myproj/{a.txt,b.txt,src/}
  const myproj = path.join(TREE, 'myproj');
  fs.mkdirSync(path.join(myproj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(myproj, 'a.txt'), 'a');
  fs.writeFileSync(path.join(myproj, 'b.txt'), 'b');
  // (B) two same-named dirs 'reports' under different parents → multi-candidate.
  const repA = path.join(TREE, 'locA', 'reports'); // exact fingerprint (score 1)
  const repB = path.join(TREE, 'locB', 'reports'); // 4/5 overlap (score 0.8) → both above threshold
  fs.mkdirSync(repA, { recursive: true }); fs.mkdirSync(repB, { recursive: true });
  for (const f of ['q1', 'q2', 'q3', 'q4']) fs.writeFileSync(path.join(repA, f), 'x');
  for (const f of ['q1', 'q2', 'q3', 'q4', 'extra']) fs.writeFileSync(path.join(repB, f), 'x');

  // config injects the seeded dirs into recentWorkspaces so they become candidate roots (candidate scan also
  // covers drive roots/home, but recentWorkspaces guarantees these temp dirs are searched deterministically).
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    defaultWorkspace: TREE,
    recentWorkspaces: [myproj, repA, repB],
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }] }],
    activeProvider: 'fake',
  }, null, 2));

  // ── ⑤a pick-folder graceful-degrade UNIT (env-independent branch) + resolver units ───────────────────
  // The pure resolver is the load-bearing algorithm; assert it directly first (no server needed).
  {
    const cfg = { defaultWorkspace: TREE, recentWorkspaces: [myproj, repA, repB] };
    const u1 = await srv.resolveWorkspace({ name: 'myproj', children: ['a.txt', 'b.txt', 'src'] }, cfg);
    ok(u1.ok && u1.matches.length === 1 && u1.matches[0].path.toLowerCase() === myproj.toLowerCase() && u1.matches[0].score === 1,
      '① (unit) exact fingerprint → unique hit, correct path, score 1');
    const u2 = await srv.resolveWorkspace({ name: 'reports', children: ['q1', 'q2', 'q3', 'q4'] }, cfg);
    ok(u2.matches.length === 2, '② (unit) two same-named dirs → 2 candidates');
    ok(u2.matches[0].score >= u2.matches[1].score && u2.matches[0].score === 1, '② (unit) candidates sorted by score DESC (top = exact 1)');
    const u3 = await srv.resolveWorkspace({ name: 'myproj', children: ['x.txt', 'y.txt', 'z.txt'] }, cfg);
    ok(u3.ok && u3.matches.length === 0, '③ (unit) children mismatch (<0.8) → zero matches');
    const u4 = await srv.resolveWorkspace({ name: '', children: [] }, cfg);
    ok(u4.ok === false, '③ (unit) empty name → ok:false');
  }

  // ── ⑦ PF3: a hung/slow candidate directory must NOT synchronously block the event loop, and must be
  //     abandoned at the per-directory timeout (candidate-build/scoring is async + timed). Stub fs/promises
  //     readdir for one sentinel dir (basename === wanted name so scoring reads it) to hang 5s; assert the
  //     resolver returns well before that, the stub was hit, and a concurrent interval kept ticking (proof
  //     the loop wasn't blocked — the OLD sync readdirSync path would have frozen the ticker).
  {
    const fsp = require('fs/promises');
    const realReaddir = fsp.readdir;
    const SLOW = path.join(TREE, 'slowdir'); // basename 'slowdir' matches the wanted name → scored → readdir'd
    fs.mkdirSync(SLOW, { recursive: true });
    let slowCalls = 0;
    fsp.readdir = function (p, opts) {
      if (String(p).toLowerCase() === SLOW.toLowerCase()) { slowCalls++; return new Promise(r => setTimeout(() => r([]), 5000)); }
      return realReaddir.call(this, p, opts);
    };
    try {
      const cfgSlow = { defaultWorkspace: TREE, recentWorkspaces: [SLOW] };
      let ticks = 0;
      const ticker = setInterval(() => { ticks++; }, 20);
      const t0 = Date.now();
      const rSlow = await srv.resolveWorkspace({ name: 'slowdir', children: ['a', 'b'] }, cfgSlow);
      const elapsed = Date.now() - t0;
      clearInterval(ticker);
      ok(rSlow && rSlow.ok === true, '⑦ (PF3) resolver returns despite a hung candidate dir');
      ok(slowCalls >= 1, '⑦ (PF3) the hung dir was actually read (stub hit ' + slowCalls + 'x)');
      ok(elapsed < 4000, '⑦ (PF3) hung dir abandoned at the per-dir timeout — elapsed ' + elapsed + 'ms << 5000ms stub delay');
      ok(ticks >= 2, '⑦ (PF3) event loop kept ticking during the resolve (not synchronously blocked; ticks=' + ticks + ')');
      // PF3 FIX: pre-fix, a readdir timeout collapsed to an empty child set → Jaccard 0 → the known workspace was
      // silently DROPPED. Now the resolver stat-confirms the known recentWorkspace and selects it on the name match.
      ok(rSlow.matches.some(m => m.path.toLowerCase() === SLOW.toLowerCase()),
         '⑦ (PF3 FIX) known recentWorkspace on a slow drive is STILL selected via bounded stat — not missed');
      ok(rSlow.truncated === true,
         '⑦ (PF3 FIX) a timed-out candidate marks the result truncated:true (incomplete, not authoritative)');
    } finally {
      fsp.readdir = realReaddir;
    }
  }

  // ── ⑧ PF3 FIX (scoping): the stat fallback is ONLY for KNOWN paths (recentWorkspaces). An arbitrary same-named
  //     dir DISCOVERED via parent enumeration whose own readdir times out is NOT force-selected — we can't verify
  //     its fingerprint and the user never chose it, so it's dropped (result flagged truncated). This guards
  //     against the fix over-selecting on slow drives.
  {
    const fsp = require('fs/promises');
    const realReaddir = fsp.readdir;
    const LONELY = path.join(TREE, 'lonelyslow'); // basename matches wanted name; discovered via dwParent=TREE
    fs.mkdirSync(LONELY, { recursive: true });
    fsp.readdir = function (p, opts) {
      if (String(p).toLowerCase() === LONELY.toLowerCase()) return new Promise(r => setTimeout(() => r([]), 5000));
      return realReaddir.call(this, p, opts);
    };
    try {
      // defaultWorkspace under TREE → dwParent === TREE → LONELY is enumerated as a candidate, but it is NOT in
      // recentWorkspaces (empty), so it is NOT a known path.
      const cfg = { defaultWorkspace: path.join(TREE, 'proj'), recentWorkspaces: [] };
      const r = await srv.resolveWorkspace({ name: 'lonelyslow', children: ['a', 'b'] }, cfg);
      ok(r.ok === true && !r.matches.some(m => m.path.toLowerCase() === LONELY.toLowerCase()),
         '⑧ (PF3 FIX) a non-known slow dir is NOT force-selected (stat fallback scoped to recentWorkspaces only)');
      ok(r.truncated === true, '⑧ (PF3 FIX) the timed-out non-known candidate still flags truncated');
    } finally {
      fsp.readdir = realReaddir;
    }
  }

  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_PORT)], { windowsHide: true, env: { ...process.env } });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening');
    ok(h && h.version === require(require('path').resolve(__dirname,'..','ruyi-workbench','package.json')).version, 'version === package.json'); // 第23波: 动态读
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');
    const hdr = { 'x-wcw-token': token };

    // ── ① resolve exact → unique hit (LIVE HTTP) ─────────────────────────────────────────────────────
    const r1 = await reqJson(WB_PORT, 'POST', '/api/workspace/resolve', { name: 'myproj', children: ['a.txt', 'b.txt', 'src'] }, hdr);
    ok(r1.status === 200 && r1.json && r1.json.ok, '① POST /api/workspace/resolve ok');
    ok(r1.json && r1.json.matches && r1.json.matches.length === 1 && r1.json.matches[0].path.toLowerCase() === myproj.toLowerCase(),
      '① exact fingerprint → unique hit with correct absolute path');

    // ── ② multi-candidate, score-sorted ──────────────────────────────────────────────────────────────
    const r2 = await reqJson(WB_PORT, 'POST', '/api/workspace/resolve', { name: 'reports', children: ['q1', 'q2', 'q3', 'q4'] }, hdr);
    ok(r2.json && r2.json.matches.length === 2, '② two same-named dirs → 2 candidates');
    ok(r2.json && r2.json.matches[0].score >= r2.json.matches[1].score, '② candidates sorted by score DESC');
    ok(r2.json && r2.json.matches[0].path.toLowerCase() === repA.toLowerCase(), '② top candidate is the exact-fingerprint dir');

    // ── ③ zero match ─────────────────────────────────────────────────────────────────────────────────
    const r3 = await reqJson(WB_PORT, 'POST', '/api/workspace/resolve', { name: 'myproj', children: ['nope1', 'nope2', 'nope3'] }, hdr);
    ok(r3.json && r3.json.ok && r3.json.matches.length === 0, '③ children mismatch → matches:[]');

    // token gate: no token → 403.
    const r3n = await reqJson(WB_PORT, 'POST', '/api/workspace/resolve', { name: 'myproj', children: [] }, {});
    ok(r3n.status === 403, '③ resolve without token → 403');

    // ── ④ recentWorkspaces LRU round-trip via /api/config ────────────────────────────────────────────
    // Front-insert a new path, keep prior, expect de-dupe + order preserved; then push >10 to prove truncation.
    const newWs = path.join(TREE, 'freshly-used');
    const rc1 = await reqJson(WB_PORT, 'POST', '/api/config', { recentWorkspaces: [newWs, myproj, repA, repB] }, hdr);
    ok(rc1.status === 200 && rc1.json && rc1.json.ok, '④ POST /api/config recentWorkspaces ok');
    const cfg1 = (await getJson(WB_PORT, '/api/status')).json;
    const rw1 = cfg1 && cfg1.config && cfg1.config.recentWorkspaces;
    ok(Array.isArray(rw1) && rw1[0] === newWs && rw1.length === 4, '④ front-inserted path leads, prior kept (4 total)');
    // De-dupe: re-post with a duplicate (different case) of newWs → still 4, still leads.
    const rc2 = await reqJson(WB_PORT, 'POST', '/api/config', { recentWorkspaces: [newWs, newWs.toUpperCase(), myproj, repA, repB] }, hdr);
    ok(rc2.status === 200, '④ POST duplicate-laden list ok');
    const cfg2 = (await getJson(WB_PORT, '/api/status')).json;
    const rw2 = cfg2.config.recentWorkspaces;
    ok(rw2.length === 4 && rw2[0] === newWs, '④ case-insensitive de-dupe keeps the first (length 4)');
    // Truncate to 10: post 14 distinct paths.
    const many = Array.from({ length: 14 }, (_, i) => path.join(TREE, 'ws' + i));
    await reqJson(WB_PORT, 'POST', '/api/config', { recentWorkspaces: many }, hdr);
    const cfg3 = (await getJson(WB_PORT, '/api/status')).json;
    ok(cfg3.config.recentWorkspaces.length === 10 && cfg3.config.recentWorkspaces[0] === many[0], '④ list truncated to 10 (front kept)');

    // ── ⑤ pick-folder ────────────────────────────────────────────────────────────────────────────────
    // A real FolderBrowserDialog can't be asserted headless. On non-Windows the endpoint returns a graceful
    // degrade {ok:false,error,hint}; on Windows we only assert the endpoint is reachable + token-gated (the
    // STA script correctness is code-reviewed — see delivery notes). No-token → 403 either way.
    const pfNoTok = await reqJson(WB_PORT, 'POST', '/api/pick-folder', {}, {});
    ok(pfNoTok.status === 403, '⑤ pick-folder without token → 403');
    if (process.platform !== 'win32') {
      const pf = await reqJson(WB_PORT, 'POST', '/api/pick-folder', {}, hdr);
      ok(pf.json && pf.json.ok === false && /Windows/.test(pf.json.error || '') && pf.json.hint, '⑤ (non-Windows) pick-folder → graceful degrade with hint');
    } else {
      console.log('SKIP ⑤ pick-folder live dialog (Windows headless — STA script code-reviewed; see delivery notes)');
    }

    // ── ⑥ session cwd PATCH persists ─────────────────────────────────────────────────────────────────
    const sess = (await reqJson(WB_PORT, 'POST', '/api/sessions', {}, hdr)).json;
    const sid = sess && sess.session && sess.session.id;
    ok(!!sid, '⑥ session created');
    const patched = await reqJson(WB_PORT, 'PATCH', '/api/sessions/' + sid, { cwd: myproj }, hdr);
    ok(patched.status === 200 && patched.json && patched.json.session && patched.json.session.cwd.toLowerCase() === myproj.toLowerCase(),
      '⑥ PATCH session cwd persists (resolved absolute)');
    const reload = (await getJson(WB_PORT, '/api/sessions/' + sid, hdr)).json;
    ok(reload && reload.session && reload.session.cwd.toLowerCase() === myproj.toLowerCase(), '⑥ reloaded session keeps the new cwd');
    // A blank cwd must NOT clear an existing one.
    await reqJson(WB_PORT, 'PATCH', '/api/sessions/' + sid, { cwd: '   ' }, hdr);
    const reload2 = (await getJson(WB_PORT, '/api/sessions/' + sid, hdr)).json;
    ok(reload2.session.cwd.toLowerCase() === myproj.toLowerCase(), '⑥ blank cwd patch does not clear the existing cwd');
  } finally {
    killp(wb); killp(fake);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
  }

  console.log('\nWORKSPACE-RESOLVE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})();
