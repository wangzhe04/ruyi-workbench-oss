// E2E (v1.4.6-S1): DNS-rebinding + CSRF hardening on the mutating-route auth gate.
// Boots a real workbench (temp HOME), then drives POST /api/sessions (a mutating route guarded by
// originOk + the new UI-token conditional) with hand-crafted Host / Origin / token combinations:
//   (1) Host: evil.example:PORT               → 403 (DNS-rebinding: Host is not this server's loopback authority).
//   (2) Host: 127.0.0.1:PORT, no Origin, token → 200 ok (a non-browser loopback caller; passes same-origin gate).
//   (3) Host: 127.0.0.1:PORT, Origin set, NO token → 403 (browser CSRF: a browser caller must carry the token).
//   (4) Host: 127.0.0.1:PORT, Origin set, token → 200 ok (the real UI: same-origin + token).
//   (5) Host: 127.0.0.1:PORT, no Origin, no token → 200 ok (the offline harness / CLI stays exempt).
// Connection always targets 127.0.0.1:PORT; only the Host HEADER is spoofed (exactly the rebinding shape).
// Uses port 9041. No fake provider needed — /api/sessions only touches config + the sessions dir.
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-dns-rebind-e2e');
const WB_PORT = 9041;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
// POST /api/sessions with a fully explicit header set (Host/Origin/token as given). Connects to loopback
// regardless of the Host header. Resolves { status, json }.
function postSessions(port, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ title: 'dns-rebind probe', cwd: HOME });
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/sessions', method: 'POST', timeout: 4000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, version: '1.0.0', permissionMode: 'bypass' }, null, 2));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');
    const goodHost = `127.0.0.1:${WB_PORT}`;
    const origin = `http://127.0.0.1:${WB_PORT}`;

    // (1) DNS-rebinding: spoofed Host → rejected outright (this is the core P1 fix).
    const r1 = await postSessions(WB_PORT, { Host: `evil.example:${WB_PORT}`, 'x-wcw-token': token });
    ok(r1.status === 403, '(1) spoofed Host (evil.example) rejected 403 (got ' + r1.status + ')');
    ok(r1.json && r1.json.ok === false, '(1) body is an error, no session created');

    // (2) loopback non-browser caller (no Origin) with correct Host + token → allowed.
    const r2 = await postSessions(WB_PORT, { Host: goodHost, 'x-wcw-token': token });
    ok(r2.status === 200 && r2.json && r2.json.ok === true && r2.json.session && r2.json.session.id, '(2) loopback+token creates a session (got ' + r2.status + ')');

    // (3) browser caller (Origin present) WITHOUT token → rejected (CSRF defense on the new gate).
    const r3 = await postSessions(WB_PORT, { Host: goodHost, Origin: origin });
    ok(r3.status === 403, '(3) browser Origin without token rejected 403 (got ' + r3.status + ')');

    // (4) the real UI shape: same-origin Origin + token → allowed.
    const r4 = await postSessions(WB_PORT, { Host: goodHost, Origin: origin, 'x-wcw-token': token });
    ok(r4.status === 200 && r4.json && r4.json.ok === true, '(4) same-origin browser WITH token allowed (got ' + r4.status + ')');

    // (5) the offline harness shape: no Origin, no token, correct Host → still allowed (loopback exempt).
    const r5 = await postSessions(WB_PORT, { Host: goodHost });
    ok(r5.status === 200 && r5.json && r5.json.ok === true, '(5) loopback no-Origin no-token still allowed (got ' + r5.status + ')');

    // (6) cross-origin browser (foreign Origin, matching bad Host) → rejected by originOk too.
    const r6 = await postSessions(WB_PORT, { Host: `evil.example:${WB_PORT}`, Origin: `http://evil.example:${WB_PORT}`, 'x-wcw-token': token });
    ok(r6.status === 403, '(6) rebinding page (Host+Origin both evil, even WITH stolen token) rejected 403 (got ' + r6.status + ')');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nDNS-REBIND E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();
