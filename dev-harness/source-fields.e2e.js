// E2E for v0.7a §5.1 message source fields. Two independent workbench instances (fresh HOME each):
//   (A) provider mode (fake-openai) — assert the persisted assistant message carries
//       engine==='openai', providerId==='fake', and a non-empty model.
//   (B) claude mode (WCW_FAKE_CLAUDE -> workbench's own tools/fake-claude.js, activeProvider empty) —
//       assert the persisted assistant message carries engine==='claude'.
// Fully offline. Mirrors the postStream/getJson skeleton from openai-engine.e2e.js.
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => {
      let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
    });
    r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); });
  });
}
function getJson(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000 }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
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
function lastAssistant(session) {
  const msgs = (session && session.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].role === 'assistant') return msgs[i];
  return null;
}
async function waitHealth(port) { let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(port); } return h; }
function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  // ---------- (A) provider mode ----------
  const FAKE_PORT = 8921, WB_PORT_A = 9144;
  const HOME_A = path.join(os.tmpdir(), 'wcw-srcfields-openai');
  fs.rmSync(HOME_A, { recursive: true, force: true }); fs.mkdirSync(HOME_A, { recursive: true });
  fs.writeFileSync(path.join(HOME_A, 'config.json'), JSON.stringify({
    configSchema: 4, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake Provider', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: true }],
    activeProvider: 'fake',
  }, null, 2));
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_PORT)], { windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wbA = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT_A)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME_A }, windowsHide: true });
  wbA.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wbA!] ' + l.trim())));
  try {
    const h = await waitHealth(WB_PORT_A);
    ok(!!h, '[openai] workbench listening on :' + WB_PORT_A);
    const events = await postStream(WB_PORT_A, { message: 'hi there' });
    const sid = (events.find(e => e.type === 'session') || {}).session?.id;
    ok(!!sid, '[openai] session id captured');
    const r = await getJson(WB_PORT_A, '/api/sessions/' + encodeURIComponent(sid));
    const a = lastAssistant(r && r.session);
    ok(!!a, '[openai] last assistant message present');
    ok(a && a.engine === 'openai', '[openai] engine==="openai" (got ' + (a && a.engine) + ')');
    ok(a && a.providerId === 'fake', '[openai] providerId==="fake" (got ' + (a && a.providerId) + ')');
    ok(a && typeof a.model === 'string' && a.model.length > 0, '[openai] model non-empty (got ' + JSON.stringify(a && a.model) + ')');
    ok(a && a.providerLabel === 'Fake Provider', '[openai] providerLabel preserved (got ' + JSON.stringify(a && a.providerLabel) + ')');
  } catch (e) { console.log('ERROR(openai) ' + e.message); fail++; }
  finally { kill(wbA); kill(fake); await sleep(300); }

  // ---------- (B) claude mode via fake-claude ----------
  const WB_PORT_B = 9145;
  const HOME_B = path.join(os.tmpdir(), 'wcw-srcfields-claude');
  fs.rmSync(HOME_B, { recursive: true, force: true }); fs.mkdirSync(HOME_B, { recursive: true });
  // activeProvider empty => Claude engine. model set so we can also confirm it lands on the message.
  fs.writeFileSync(path.join(HOME_B, 'config.json'), JSON.stringify({
    configSchema: 4, version: '1.0.0', permissionMode: 'bypass', activeProvider: '', model: 'claude-test-model',
  }, null, 2));
  ok(fs.existsSync(FAKE_CLAUDE), '[claude] fake-claude.js exists at ' + FAKE_CLAUDE);
  const wbB = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT_B)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME_B, WCW_FAKE_CLAUDE: FAKE_CLAUDE }, windowsHide: true });
  wbB.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wbB!] ' + l.trim())));
  try {
    const h = await waitHealth(WB_PORT_B);
    ok(!!h, '[claude] workbench listening on :' + WB_PORT_B);
    const events = await postStream(WB_PORT_B, { message: 'hello claude' });
    const sid = (events.find(e => e.type === 'session') || {}).session?.id;
    ok(!!sid, '[claude] session id captured');
    const r = await getJson(WB_PORT_B, '/api/sessions/' + encodeURIComponent(sid));
    const a = lastAssistant(r && r.session);
    ok(!!a, '[claude] last assistant message present');
    ok(a && a.engine === 'claude', '[claude] engine==="claude" (got ' + (a && a.engine) + ')');
    ok(a && a.model === 'claude-test-model', '[claude] model carried through (got ' + JSON.stringify(a && a.model) + ')');
  } catch (e) { console.log('ERROR(claude) ' + e.message); fail++; }
  finally { kill(wbB); await sleep(300); }

  fs.rmSync(HOME_A, { recursive: true, force: true });
  fs.rmSync(HOME_B, { recursive: true, force: true });
  console.log('\nSOURCE-FIELDS E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})();
