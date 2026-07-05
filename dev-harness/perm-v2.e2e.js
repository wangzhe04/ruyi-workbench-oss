// E2E (v0.8-S4b): permission UX v2 — the permission_request event's new fields (tier + revertible) and
// the persistent config.toolAllowRules allowlist (+ its hard cleanse). permissionMode:'default' so an
// edit-tier tool prompts; permissionTimeoutMs:6000 so an un-answered prompt auto-denies fast. Covers:
//  ① FAKE_TOOL_NAME=file_write (edit tier → gate 'ask') → the streamed permission_request event carries
//     tier:'edit' and revertible:true; nobody answers → auto-deny after 6s → the turn still finishes
//     normally (result present; the tool result is a denial, the model echoes it).
//  ② config pre-seeds toolAllowRules:{file_write:'allow'} → the SAME call does NOT emit a
//     permission_request and the file is written (rule short-circuits the 'ask').
//  ③ config pre-seeds toolAllowRules:{powershell_run:'allow'} (ILLEGAL — exec tier) → normalizeConfig
//     strips it → GET /api/status shows config.toolAllowRules without that entry.
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-permv2-e2e');
const FAKE_PORT = 8980, WB_PORT = 8981;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
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
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
function fakeReachable() { return new Promise(resolve => { const net = require('net'); const s = net.connect({ host: '127.0.0.1', port: FAKE_PORT }, () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); s.setTimeout(500, () => { s.destroy(); resolve(false); }); }); }
async function waitFakeUp() { for (let i = 0; i < 50; i++) { if (await fakeReachable()) return true; await sleep(100); } return false; }
async function waitFakeDown() { for (let i = 0; i < 50; i++) { if (!await fakeReachable()) return true; await sleep(100); } return false; }
// A fake-openai that calls a single named tool with args on the first tools-turn, then echoes.
function spawnFake(toolName, toolArgs) {
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_NAME: toolName, FAKE_TOOL_ARGS: JSON.stringify(toolArgs || {}) }, windowsHide: true });
  fake.stdout.on('data', () => {});
  return fake;
}
// permissionMode:'default' + short timeout + optional pre-seeded toolAllowRules.
function writeConfig(home, fakePort, allowRules) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'default', permissionTimeoutMs: 6000,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
    activeProvider: 'fake',
    ...(allowRules ? { toolAllowRules: allowRules } : {}),
  }, null, 2));
}
// Start the workbench, run a body, then stop it — so we can restart with different config between scenarios.
async function withWb(allowRules, fn) {
  writeConfig(HOME, FAKE_PORT, allowRules);
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
  try { await fn(!!h); } finally { killp(wb); await sleep(400); }
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const target = path.join(HOME, 'perm.txt');
  const fakes = [];

  try {
    // ============ ① default mode: file_write (edit tier) → permission_request tier:'edit' revertible:true ============
    const f1 = spawnFake('file_write', { path: target, content: 'should-not-write-when-denied' }); fakes.push(f1);
    ok(await waitFakeUp(), '① fake up');
    await withWb(null, async up => {
      ok(up, '① workbench up (default mode)');
      const created = await postJson(WB_PORT, '/api/sessions', { title: 'perm t1', cwd: HOME });
      const sid = created.body.session.id;
      const t0 = Date.now();
      const ev = await postStream(WB_PORT, { sessionId: sid, message: 'write the file', cwd: HOME });
      const elapsed = Date.now() - t0;
      const pr = ev.find(e => e.type === 'permission_request');
      ok(!!pr, '① permission_request emitted for file_write');
      ok(pr && pr.tier === 'edit', '① permission_request tier === edit (got ' + (pr && pr.tier) + ')');
      ok(pr && pr.revertible === true, '① permission_request revertible === true');
      const result = ev.find(e => e.type === 'result');
      ok(!!result, '① turn produced a result event (finished normally after auto-deny)');
      ok(elapsed >= 5500, '① turn waited out the ~6s permission timeout (elapsed ' + elapsed + 'ms)');
      ok(!fs.existsSync(target), '① file NOT written (auto-denied)');
    });
    killp(f1); await waitFakeDown();

    // ============ ② toolAllowRules:{file_write:'allow'} → NO permission_request, file written ============
    const f2 = spawnFake('file_write', { path: target, content: 'written-via-allow-rule' }); fakes.push(f2);
    ok(await waitFakeUp(), '② fake up');
    await withWb({ file_write: 'allow' }, async up => {
      ok(up, '② workbench up (with allow rule)');
      // Confirm the rule survived normalizeConfig (file_write is edit tier → legal).
      const st = (await getJson(WB_PORT, '/api/status')).body;
      ok(st.config && st.config.toolAllowRules && st.config.toolAllowRules.file_write === 'allow', '② toolAllowRules.file_write survived normalize');
      const created = await postJson(WB_PORT, '/api/sessions', { title: 'perm t2', cwd: HOME });
      const sid = created.body.session.id;
      const ev = await postStream(WB_PORT, { sessionId: sid, message: 'write the file', cwd: HOME });
      const pr = ev.find(e => e.type === 'permission_request');
      ok(!pr, '② NO permission_request (allow rule short-circuited the prompt)');
      ok(fs.existsSync(target) && fs.readFileSync(target, 'utf8') === 'written-via-allow-rule', '② file written directly');
    });
    killp(f2); await waitFakeDown();

    // ============ ③ toolAllowRules:{powershell_run:'allow'} (illegal exec tier) → cleansed away ============
    await withWb({ powershell_run: 'allow' }, async up => {
      ok(up, '③ workbench up (with illegal exec allow rule)');
      const st = (await getJson(WB_PORT, '/api/status')).body;
      const rules = (st.config && st.config.toolAllowRules) || {};
      ok(!('powershell_run' in rules), '③ powershell_run stripped from toolAllowRules by normalizeConfig');
      ok(Object.keys(rules).length === 0, '③ toolAllowRules is now empty (illegal entry dropped)');
    });
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of fakes) killp(c);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nPERM-V2 E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();
