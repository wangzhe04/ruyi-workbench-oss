(async () => {
// E2E (v0.9-S8): 审计中心 — GET /api/audit merges the workbench NDJSON logs (logEvent) + the desktop MCP
// audit_tail into one read-only, ts-descending timeline. Offline (fake-openai; no ACC bridge). Covers:
//  (a) run one provider turn (fake-openai plain echo) → GET /api/audit (with token) → entries contain the
//      workbench turn_start + turn_end kinds, sorted ts-descending, with non-empty human-friendly summaries.
//  (b) NO UI token → 403.
//  (c) source=workbench filter → every entry has source==='workbench'.
//  (d) desktop source: this instance has NO ACC bridge → sources.desktop==='unavailable' AND no entry has
//      source==='desktop' (degraded, never an error — response is still {ok:true}).
//  (e) 脱敏: a log record carrying an api-key-shaped secret → the audit response detail is redacted (the
//      plaintext secret NEVER appears anywhere in the response body).
//  (f) limit clamp: limit=9999 → server clamps to ≤500 (asserted via entries.length ≤ 500).
// Token手法 copied from checkpoint.e2e.js (meta scrape). Direct tool calls carry sessionId so they journal.
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-audit-e2e');
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p, headers) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000, headers: headers || {} }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { resolve({ status: resp.statusCode, body: b, json: JSON.parse(b) }); } catch (e) { resolve({ status: resp.statusCode, body: b, json: null }); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
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
function writeConfig(home, fakePort) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 7, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
    activeProvider: 'fake',
    // (d): NO desktop MCP bridge — normalizeConfig would otherwise backfill enabled+autodetect and, on a dev
    // machine with a real ACC checkout, the bridge would go live. Disable it so 'desktop unavailable' is
    // deterministic offline.
    desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
  }, null, 2));
}
function spawnFake() {
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT) }, windowsHide: true });
  fake.stdout.on('data', () => {});
  return fake;
}
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
function fakeReachable() { return new Promise(resolve => { const net = require('net'); const s = net.connect({ host: '127.0.0.1', port: FAKE_PORT }, () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); s.setTimeout(500, () => { s.destroy(); resolve(false); }); }); }
async function waitFakeUp() { for (let i = 0; i < 50; i++) { if (await fakeReachable()) return true; await sleep(100); } return false; }

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  writeConfig(HOME, FAKE_PORT);
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  procs.push(wb);

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');

    const created = await postJson(WB_PORT, '/api/sessions', { title: 'audit test', cwd: HOME });
    const sid = created.body.session && created.body.session.id;
    ok(!!sid, 'session created');

    // ============ (a) run one provider turn → workbench turn_start/turn_end are logged & aggregated ============
    const fake = spawnFake();
    procs.push(fake);
    ok(await waitFakeUp(), '(a) fake-openai listening on :' + FAKE_PORT);
    await postStream(WB_PORT, { sessionId: sid, message: 'hello audit', cwd: HOME });
    await sleep(250); // give the log stream a beat to flush

    const aRes = await getJson(WB_PORT, '/api/audit?limit=100', { 'x-wcw-token': token });
    ok(aRes.status === 200 && aRes.json && aRes.json.ok === true, '(a) GET /api/audit ok');
    const entries = (aRes.json && aRes.json.entries) || [];
    ok(Array.isArray(entries) && entries.length > 0, '(a) audit has entries (got ' + entries.length + ')');
    ok(entries.some(e => e.type === 'turn_start' && e.source === 'workbench'), '(a) contains a workbench turn_start entry');
    ok(entries.some(e => e.type === 'turn_end' && e.source === 'workbench'), '(a) contains a workbench turn_end entry');
    // human-friendly summaries non-empty
    const ts = entries.find(e => e.type === 'turn_start');
    ok(ts && typeof ts.summary === 'string' && ts.summary.trim().length > 0, '(a) turn_start summary is non-empty human phrasing (' + (ts && ts.summary) + ')');
    ok(ts && ts.summary.indexOf('开始回合') === 0, '(a) turn_start summary human-mapped to 开始回合');
    // ts-descending: each ts >= the next
    let descending = true;
    for (let i = 1; i < entries.length; i++) { if (String(entries[i - 1].ts) < String(entries[i].ts)) { descending = false; break; } }
    ok(descending, '(a) entries sorted ts-descending (new→old)');

    // ============ (b) no token → 403 ============
    const noTok = await getJson(WB_PORT, '/api/audit?limit=100');
    ok(noTok.status === 403, '(b) GET /api/audit without UI token → 403 (got ' + noTok.status + ')');

    // ============ (c) source=workbench filter → every entry is source:workbench ============
    const wbOnly = await getJson(WB_PORT, '/api/audit?limit=100&source=workbench', { 'x-wcw-token': token });
    const wbEntries = (wbOnly.json && wbOnly.json.entries) || [];
    ok(wbEntries.length > 0 && wbEntries.every(e => e.source === 'workbench'), '(c) source=workbench filter → all entries source:workbench');

    // ============ (d) desktop source unavailable (no ACC bridge) → marked & absent ============
    ok(aRes.json.sources && aRes.json.sources.desktop === 'unavailable', "(d) sources.desktop === 'unavailable' with no ACC bridge (got " + (aRes.json.sources && aRes.json.sources.desktop) + ')');
    ok(aRes.json.sources && aRes.json.sources.workbench === true, '(d) sources.workbench === true');
    ok(!entries.some(e => e.source === 'desktop'), '(d) no desktop-source entries (degraded, not an error)');

    // ============ (e) 脱敏: a secret-bearing log record is redacted in the audit response ============
    // Directly append a log line carrying an api-key-shaped secret (mirrors what logEvent writes), then
    // GET /api/audit and assert the plaintext secret is NOT anywhere in the response body.
    // 18 alnum after sk- → matches REDACT_PATTERNS sk-[A-Za-z0-9]{16,} (so redact() fires) but NOT the
    // repo-hygiene secret scanner's sk-[a-zA-Z0-9]{20,} (so this test fixture isn't flagged as a real leak).
    const SECRET = 'sk-ABCDEF0123456789ab';
    const logsDir = path.join(HOME, 'logs');
    const logFiles = fs.readdirSync(logsDir).filter(f => /^workbench-.*\.ndjson$/.test(f)).sort();
    const latest = logFiles[logFiles.length - 1];
    fs.appendFileSync(path.join(logsDir, latest), JSON.stringify({ ts: new Date().toISOString(), kind: 'server_start', note: 'apiKey=' + SECRET, blob: SECRET }) + '\n');
    const redRes = await getJson(WB_PORT, '/api/audit?limit=200', { 'x-wcw-token': token });
    ok(redRes.status === 200, '(e) GET /api/audit after injecting a secret log line ok');
    ok(redRes.body.indexOf(SECRET) === -1, '(e) plaintext secret is redacted — NOT present in the audit response body');
    ok(redRes.body.indexOf('«redacted»') !== -1, '(e) response contains a «redacted» marker (redact() ran on detail)');

    // ============ (f) limit clamp: limit=9999 → server clamps ≤500 ============
    const bigRes = await getJson(WB_PORT, '/api/audit?limit=9999', { 'x-wcw-token': token });
    const bigEntries = (bigRes.json && bigRes.json.entries) || [];
    ok(bigRes.status === 200 && bigEntries.length <= 500, '(f) limit=9999 clamped → entries.length ≤ 500 (got ' + bigEntries.length + ')');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) killp(c);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nAUDIT E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
