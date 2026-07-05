// E2E for v0.7b §5.2 provider context compaction. Start fake-openai + the REAL workbench in provider
// mode, chat one turn (grows providerHistory), POST /api/provider/compact, then assert:
//   - {ok:true} with before/after token estimates
//   - GET session -> providerHistory.length === 2 (summary user + ack assistant)
//   - session.messages last entry role==='system' containing 「已压缩」
//   - a follow-up chat turn still streams (compaction didn't break the engine)
// fake-openai's stream:false branch returns a fixed non-stream reply, used for the summary call.
// Fully offline. Skeleton mirrors openai-engine.e2e.js.
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_PORT = 8931;
const WB_PORT = 8834;
const HOME = path.join(os.tmpdir(), 'wcw-compact-e2e');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '1.0.0', permissionMode: 'bypass',
  providers: [{
    id: 'fake', label: 'Fake', type: 'openai-compat',
    baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'test-key',
    model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }], reasoning: true,
  }],
  activeProvider: 'fake',
}, null, 2));

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
function postJson(port, p, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
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

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_PORT)], { windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);
    ok(h && h.version === '1.4.0', 'version 1.4.0 (got ' + (h && h.version) + ')');

    // Turn 1: chat so providerHistory grows past the two-entry compacted shape.
    const events = await postStream(WB_PORT, { message: 'hi there, remember this fact: sky is blue' });
    const sid = (events.find(e => e.type === 'session') || {}).session?.id;
    ok(!!sid, 'session id captured');
    const before = await getJson(WB_PORT, '/api/sessions/' + encodeURIComponent(sid));
    const phBefore = (before && before.session && before.session.providerHistory) || [];
    ok(phBefore.length >= 2, 'providerHistory grew before compact (len=' + phBefore.length + ')');

    // Compact.
    const cr = await postJson(WB_PORT, '/api/provider/compact', { sessionId: sid });
    ok(cr && cr.ok === true, 'compact returns {ok:true} (err=' + (cr && cr.error) + ')');
    ok(cr && typeof cr.beforeTokens === 'number' && typeof cr.afterTokens === 'number', 'compact returns before/after token estimates (' + (cr && cr.beforeTokens) + '→' + (cr && cr.afterTokens) + ')');

    // Assert post-compact session shape.
    const after = await getJson(WB_PORT, '/api/sessions/' + encodeURIComponent(sid));
    const sess = after && after.session;
    const ph = (sess && sess.providerHistory) || [];
    ok(ph.length === 2, 'providerHistory.length === 2 after compact (got ' + ph.length + ')');
    ok(ph[0] && ph[0].role === 'user' && /压缩摘要/.test(ph[0].content || ''), 'providerHistory[0] is the summary user message');
    ok(ph[1] && ph[1].role === 'assistant', 'providerHistory[1] is the ack assistant message');
    const msgs = (sess && sess.messages) || [];
    const last = msgs[msgs.length - 1];
    ok(last && last.role === 'system', 'last message role === "system" (got ' + (last && last.role) + ')');
    ok(last && /已压缩/.test(last.content || ''), 'system message contains 「已压缩」 ("' + (last && (last.content || '').slice(0, 30)) + '")');

    // Follow-up turn after compaction: engine must still work.
    const events2 = await postStream(WB_PORT, { message: 'continue please', sessionId: sid });
    const text2 = events2.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    const result2 = events2.find(e => e.type === 'result');
    ok(/Hello, world/.test(text2), 'post-compact turn streams ("' + text2.slice(0, 30) + '")');
    ok(result2 && result2.ok === true, 'post-compact turn result ok=true');
  } catch (e) { console.log('ERROR ' + e.message); fail++; }
  finally {
    for (const c of [wb, fake]) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nPROVIDER-COMPACT E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
