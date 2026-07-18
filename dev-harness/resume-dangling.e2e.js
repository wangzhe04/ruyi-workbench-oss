(async () => {
// E2E (v0.8-S0 A6): dangling-turn detection surfaced via GET /api/sessions/<id>.resumable.
// Start workbench → create sessions → write providerHistory shapes directly into the sessions files →
// GET each session and assert resumable. Cases: tail role:'user' (unanswered turn) → dangling true
// kind 'user'; complete user→assistant → false; tail role:'tool' with all tool_calls answered (the
// persisted shape of Stop-mid-tool-loop) → dangling true kind 'tool_calls'.
// No provider/turn needed (detection is pure file inspection). Offline.
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const { getFreePort } = require('./free-port.js');

const WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-resume-dangling-e2e');
const SESSDIR = path.join(HOME, 'sessions');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 4, version: '0.7.0', permissionMode: 'bypass' }, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getJson(port, p) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000 }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j }); }); });
    r.on('error', () => resolve({ status: 0, json: null })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null }); });
  });
}
function postJson(port, p, payload) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null)); req.write(data); req.end();
  });
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  // v1.9 存储 v2:providerHistory 正文在 <id>.provider.ndjson,头只带 providerHistoryCount 计数(头是提交点)。
  // 带外注入 = 重写正文 + 同步头计数;legacy 单文件布局回退内联写(与 e3/mission-driver 同款迁移)。
  function injectProviderHistory(id, entries) {
    const file = path.join(SESSDIR, id + '.json');
    const head = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (head.storageVersion === 2 || Number.isInteger(head.providerHistoryCount)) {
      fs.writeFileSync(path.join(SESSDIR, id + '.provider.ndjson'), entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
      head.providerHistoryCount = entries.length;
    } else {
      head.providerHistory = entries;
    }
    fs.writeFileSync(file, JSON.stringify(head, null, 2));
  }
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);

    // --- Dangling session: providerHistory ends on an unanswered role:'user' ---
    const mkA = await postJson(WB_PORT, '/api/sessions', { title: 'dangling', cwd: HOME });
    const idA = mkA && mkA.session && mkA.session.id;
    ok(!!idA, 'dangling session created (id=' + idA + ')');
    injectProviderHistory(idA, [
      { role: 'user', content: '第一件事' },
      { role: 'assistant', content: '好的，已完成第一件事。' },
      { role: 'user', content: '第二件事（未完成）' }, // dangling tail
    ]);
    const getA = await getJson(WB_PORT, '/api/sessions/' + idA);
    ok(getA.status === 200 && getA.json && getA.json.ok === true, 'GET dangling session ok (status ' + getA.status + ')');
    ok(getA.json && getA.json.resumable && getA.json.resumable.dangling === true, 'resumable.dangling === true (got ' + JSON.stringify(getA.json && getA.json.resumable) + ')');
    ok(getA.json && getA.json.resumable && getA.json.resumable.kind === 'user', "resumable.kind === 'user'");

    // --- Complete session: user→assistant, no dangling tail ---
    const mkB = await postJson(WB_PORT, '/api/sessions', { title: 'complete', cwd: HOME });
    const idB = mkB && mkB.session && mkB.session.id;
    ok(!!idB, 'complete session created (id=' + idB + ')');
    injectProviderHistory(idB, [
      { role: 'user', content: '做点事' },
      { role: 'assistant', content: '已完成。' },
    ]);
    const getB = await getJson(WB_PORT, '/api/sessions/' + idB);
    ok(getB.json && getB.json.resumable && getB.json.resumable.dangling === false, 'complete session resumable.dangling === false (got ' + JSON.stringify(getB.json && getB.json.resumable) + ')');

    // --- Stop-mid-loop session: tail is role:'tool' (all tool_call_ids answered, no closing assistant).
    // This is what runOpenAiTurn persists when the user hits Stop (or the watchdog aborts) after a tool
    // result lands but before the next model call — the MOST common interruption shape. ---
    const mkC = await postJson(WB_PORT, '/api/sessions', { title: 'stopped-mid-loop', cwd: HOME });
    const idC = mkC && mkC.session && mkC.session.id;
    ok(!!idC, 'stopped-mid-loop session created (id=' + idC + ')');
    injectProviderHistory(idC, [
      { role: 'user', content: '读取文件' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'file_read', arguments: '{"path":"x.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true,"content":"..."}' }, // answered, but no closing assistant
    ]);
    const getC = await getJson(WB_PORT, '/api/sessions/' + idC);
    ok(getC.json && getC.json.resumable && getC.json.resumable.dangling === true, 'tail role:tool resumable.dangling === true (got ' + JSON.stringify(getC.json && getC.json.resumable) + ')');
    ok(getC.json && getC.json.resumable && getC.json.resumable.kind === 'tool_calls', "tail role:tool resumable.kind === 'tool_calls'");
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nRESUME-DANGLING E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
