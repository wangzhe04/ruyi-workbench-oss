// E2E (v0.8-S0): session durability. Verifies the atomic write (no *.tmp residue), corrupt-file
// isolation (.corrupt + 404 + list survives), the top-level configSchema/version, and turnSeq +
// schemaVersion after two turns. Offline (fake-openai plain-chat path; no tools needed).
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const { getFreePort } = require('./free-port.js');

const HERE = __dirname;
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-session-atomic-e2e');
const SESSDIR = path.join(HOME, 'sessions');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '0.7.0', permissionMode: 'bypass',
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
  activeProvider: 'fake',
}, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getJson(port, p) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000 }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', () => resolve({ status: 0, json: null })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null }); });
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

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT) }, windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);

    // (3) /api/status exposes the current config schema and package version.
    const status = await getJson(WB_PORT, '/api/status');
    ok(status.json && status.json.configSchema === 8, 'status.configSchema === 8 (got ' + (status.json && status.json.configSchema) + ')');
    const PKG_VERSION = require(path.join(WB, 'package.json')).version; // 第23波: 版本号动态读,不再硬编码(存量过期断言)
    ok(status.json && status.json.version === PKG_VERSION, 'status.version === package.json version "' + PKG_VERSION + '" (got ' + (status.json && status.json.version) + ')');

    // Create a session and run a turn.
    const created = await getJson(WB_PORT, '/api/sessions'); // warm the dir
    const mk = await new Promise(resolve => {
      const data = JSON.stringify({ title: 'atomic', cwd: HOME });
      const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/sessions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
      req.on('error', () => resolve(null)); req.write(data); req.end();
    });
    const sid = mk && mk.session && mk.session.id;
    ok(!!sid, 'session created (id=' + sid + ')');

    // (4) Run TWO turns; assert turnSeq === 2 and schemaVersion === 1 in the file.
    await postStream(WB_PORT, { sessionId: sid, message: '第一轮', cwd: HOME });
    await postStream(WB_PORT, { sessionId: sid, message: '第二轮', cwd: HOME });
    await sleep(150);
    const sfile = JSON.parse(fs.readFileSync(path.join(SESSDIR, sid + '.json'), 'utf8'));
    ok(sfile.turnSeq === 2, 'session file turnSeq === 2 (got ' + sfile.turnSeq + ')');
    ok(sfile.schemaVersion === 1, 'session file schemaVersion === 1 (got ' + sfile.schemaVersion + ')');

    // (1) No *.tmp residue in the sessions dir after turns complete.
    const residue = fs.readdirSync(SESSDIR).filter(f => f.endsWith('.tmp'));
    ok(residue.length === 0, 'no *.tmp residue in sessions dir (found ' + JSON.stringify(residue) + ')');

    // (2) A corrupt session file: list must not 500; GET that session 404s; a .corrupt file appears.
    const badId = 'sess-broken';
    fs.writeFileSync(path.join(SESSDIR, badId + '.json'), '{ this is not valid json ');
    const list = await getJson(WB_PORT, '/api/sessions');
    ok(list.status === 200 && list.json && list.json.ok === true, 'GET /api/sessions returns 200 with a corrupt file present (status ' + list.status + ')');
    const getBad = await getJson(WB_PORT, '/api/sessions/' + badId);
    ok(getBad.status === 404, 'GET corrupt session 404 (got ' + getBad.status + ')');
    await sleep(100);
    const corruptFile = fs.existsSync(path.join(SESSDIR, badId + '.json.corrupt'));
    ok(corruptFile, badId + '.json.corrupt isolated on disk');
    const stillBad = fs.existsSync(path.join(SESSDIR, badId + '.json'));
    ok(!stillBad, 'original corrupt .json was renamed away');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of [wb, fake]) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nSESSION-ATOMIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
