// E2E (v0.8-S2): persistent shell sessions on the native provider engine. Offline; drives the workbench
// via the fake OpenAI server (FAKE_TOOL_SEQUENCE) for the in-turn tool loop, then hits the token-gated
// /api/tools/* HTTP surface directly to prove cross-turn survival (session lives in the serve process)
// and to exercise concurrency-cap + kill. One workbench + one fake for the whole run. Ports 8967-8969.
//
// Coverage:
//  (a) SEQUENCE [shell_start{shellId:'s1'}, shell_send{input:'$PWD.Path'}] in ONE turn → start ok +
//      send output contains the WORK path (proves the session persisted BETWEEN the two tool calls).
//  (b) cross-turn survival + UI-token通路: after the turn, POST /api/tools/shell_poll {shellId:'s1'}
//      (token scraped from index.html) → running:true, then shell_send echo NEW marker → marker appears.
//  (c) concurrency cap: start s2, s3 (cap=3 → ok), s4 → error contains 上限.
//  (d) kill s1 → shell_list no longer contains s1.
//  (e) F1: cap counts LIVE sessions only — after the kill, a new start succeeds.
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-shell-session-e2e');
const FAKE_PORT = 8967, WB_PORT = 8968;
const WORK = path.join(HOME, 'work');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
// Scrape the UI token from the injected <meta name="wcw-token" content="..."> in index.html.
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function tool(port, token, name, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port, path: '/api/tools/' + name, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-wcw-token': token } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b)); } });
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
  const procs = [];
  try {
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    // config: native fake provider (so the engine runs toolCall() in-process, where shell state lives).
    // shellSessionMax:3 → s1,s2,s3 fit, s4 trips the cap.
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 6, version: '1.0.0', permissionMode: 'bypass', shellSessionMax: 3,
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
      activeProvider: 'fake',
    }, null, 2));

    // (a) SEQUENCE: start s1 (deterministic id) then send $PWD.Path — both in one turn.
    const seq = JSON.stringify([
      { name: 'shell_start', args: { shellId: 's1', cwd: WORK } },
      { name: 'shell_send', args: { shellId: 's1', input: '$PWD.Path' } },
    ]);
    const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_SEQUENCE: seq }, windowsHide: true });
    fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
    wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
    procs.push(fake, wb);

    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up');
    const token = await getToken(WB_PORT);
    ok(!!token, 'scraped UI token from index.html');

    const events = await postStream(WB_PORT, { message: '起个 shell 并看当前目录', cwd: WORK });
    const results = events.filter(e => e.type === 'tool_result');
    ok(results.length >= 2, '(a) at least 2 tool_result events (got ' + results.length + ')');
    const startRes = results[0] && results[0].content;
    ok(startRes && startRes.ok === true && startRes.shellId === 's1', '(a) shell_start ok with shellId s1');
    const sendRes = results[1] && results[1].content;
    ok(sendRes && sendRes.ok === true, '(a) shell_send ok');
    const sendOut = (sendRes && sendRes.output) || '';
    // WORK path echoed by $PWD.Path — compare on the leaf so slash flavor / casing don't bite.
    ok(sendOut.includes(path.basename(WORK)) || sendOut.toLowerCase().includes(WORK.toLowerCase()), '(a) send output contains WORK path (got: ' + JSON.stringify(sendOut.slice(0, 120)) + ')');
    ok(sendRes && sendRes.running === true, '(a) session still running after send');

    // (b) cross-turn survival via the token-gated HTTP surface (same serve process, new "turn").
    const pollRes = await tool(WB_PORT, token, 'shell_poll', { shellId: 's1', cursor: 0 });
    ok(pollRes.result && pollRes.result.ok === true && pollRes.result.running === true, '(b) shell_poll after turn: running:true (cross-turn survival)');
    const echo = await tool(WB_PORT, token, 'shell_send', { shellId: 's1', input: 'echo ALIVE_MARKER_2' });
    ok(echo.result && echo.result.ok === true && String(echo.result.output || '').includes('ALIVE_MARKER_2'), '(b) shell_send echoes NEW marker (session alive across turn + UI-token通路)');

    // (c) concurrency cap: cap=3 → s2,s3 ok, s4 errors with 上限.
    const s2 = await tool(WB_PORT, token, 'shell_start', { shellId: 's2', cwd: WORK });
    ok(s2.result && s2.result.ok === true, '(c) start s2 ok');
    const s3 = await tool(WB_PORT, token, 'shell_start', { shellId: 's3', cwd: WORK });
    ok(s3.result && s3.result.ok === true, '(c) start s3 ok');
    const s4 = await tool(WB_PORT, token, 'shell_start', { shellId: 's4', cwd: WORK });
    ok(s4.result && s4.result.ok === false && String(s4.result.error || '').includes('上限'), '(c) start s4 rejected: error contains 上限 (got: ' + (s4.result && s4.result.error) + ')');

    // Bonus: deterministic-id clash + bad-id validation (under cap now would need a free slot; test on s2 name).
    const dup = await tool(WB_PORT, token, 'shell_start', { shellId: 's1' });
    ok(dup.result && dup.result.ok === false, '(c) duplicate/at-cap start rejected');

    // (d) kill s1 → shell_list no longer lists s1 (and frees a slot).
    const kill = await tool(WB_PORT, token, 'shell_kill', { shellId: 's1' });
    ok(kill.result && kill.result.ok === true, '(d) shell_kill s1 ok');
    const list = await tool(WB_PORT, token, 'shell_list', {});
    const ids = ((list.result && list.result.shells) || []).map(s => s.shellId);
    ok(!ids.includes('s1'), '(d) shell_list no longer contains s1 (got: ' + JSON.stringify(ids) + ')');
    ok(ids.includes('s2') && ids.includes('s3'), '(d) shell_list still contains s2, s3');

    // (e) v0.8-S2fix F1: the cap counts LIVE sessions only — after killing s1 (2 active of cap 3),
    // a new start must succeed (a Map-size count would eventually block on dead/exited entries).
    const s5 = await tool(WB_PORT, token, 'shell_start', { shellId: 's5', cwd: WORK });
    ok(s5.result && s5.result.ok === true, '(e) start s5 after kill succeeds (cap counts live sessions only)');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    // Kill the workbench tree (reaps its shell children too), then the fake.
    for (const c of procs) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nSHELL-SESSION E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
