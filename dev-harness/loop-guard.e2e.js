// E2E (v0.8-S7): loop detection on the provider engine (fake-openai, offline). §4 A3 / §6 0.8-S7.
// FAKE_TOOL_SEQUENCE = the SAME file_read{path: <same file>} repeated 6×. The workbench's loop guard:
//   ① the 3rd consecutive identical tool_result carries `loopWarning`;
//   ② tool_use total ≤ 5 (the 5th call is refused-before-execution and the turn aborts, so the fake's
//      6th sequence entry is never consumed);
//   ③ the terminal `result` event has errorClass === 'tool_loop';
//   ④ the final assistant text contains 「已停止本轮」 and does NOT contain 「已达工具调用上限」;
//   ⑤ a turn_summary is still emitted;
//   ⑥ a fresh turn afterwards works normally (the loop counter does NOT persist across turns).
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-loop-guard-e2e');
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function postJson(port, p, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b)); } }); });
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
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
    activeProvider: 'fake',
  }, null, 2));
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  // A real file so file_read SUCCEEDS — the loop guard must warn/abort even on a succeeding-but-repeating call.
  const target = path.join(HOME, 'read-me.txt');
  fs.writeFileSync(target, 'loop guard fixture content');
  writeConfig(HOME, FAKE_PORT);
  // Same file_read call SIX times in a row.
  const step = { name: 'file_read', args: { path: target } };
  const seq = JSON.stringify([step, step, step, step, step, step]);
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_SEQUENCE: seq }, windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  procs.push(fake, wb);

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);

    const created = await postJson(WB_PORT, '/api/sessions', { title: 'loop test', cwd: HOME });
    const sid = created.session && created.session.id;
    ok(!!sid, 'session created');

    // ---- Turn 1: the repeated file_read sequence ----
    const ev1 = await postStream(WB_PORT, { sessionId: sid, message: '开始', cwd: HOME });
    const toolResults = ev1.filter(e => e.type === 'tool_result');
    const toolUses = ev1.filter(e => e.type === 'tool_use');

    // ① 3rd consecutive tool_result carries loopWarning.
    const third = toolResults[2];
    ok(third && third.content && typeof third.content.loopWarning === 'string' && /第 3 次/.test(third.content.loopWarning),
      'turn1: 3rd tool_result carries loopWarning (got ' + (third && third.content && third.content.loopWarning) + ')');

    // ② tool_use total ≤ 5 (5th refused-before-execution, turn aborts; the 6th seq entry is never consumed).
    ok(toolUses.length <= 5, 'turn1: tool_use count ≤ 5 (got ' + toolUses.length + ')');
    // The 5th tool_result should be the self-contained loopAborted refusal.
    const fifth = toolResults[4];
    ok(fifth && fifth.content && fifth.content.loopAborted === true && /连续 5 次/.test(fifth.content.error || ''),
      'turn1: 5th tool_result is the loopAborted refusal (got ' + JSON.stringify(fifth && fifth.content) + ')');

    // ③ terminal result event → errorClass === 'tool_loop'.
    const result1 = [...ev1].reverse().find(e => e.type === 'result');
    ok(result1 && result1.errorClass === 'tool_loop', 'turn1: result errorClass === tool_loop (got ' + (result1 && result1.errorClass) + ')');

    // ④ final assistant text contains 「已停止本轮」 and NOT 「已达工具调用上限」.
    const text1 = ev1.filter(e => e.type === 'assistant_delta').map(e => e.text || '').join('');
    ok(/已停止本轮/.test(text1), 'turn1: assistant text contains 「已停止本轮」');
    ok(!/已达工具调用上限/.test(text1), 'turn1: assistant text does NOT contain 「已达工具调用上限」 (distinct message)');

    // ⑤ turn_summary still emitted.
    const ts1 = ev1.find(e => e.type === 'turn_summary');
    ok(!!ts1, 'turn1: turn_summary emitted despite the loop abort');

    // ⑥ a fresh turn afterwards is normal — the loop counter does NOT persist across turns. The sequence
    //    is exhausted (6 entries, but only 4 tool results were produced before abort), so the fake still
    //    has entries left; a NEW turn continues the sequence but the guard counter is reset, so it will
    //    produce warnings again only after 3 more consecutive. What we assert here is simply that the turn
    //    completes and emits its own turn_summary + result (no crash, counter fresh).
    const ev2 = await postStream(WB_PORT, { sessionId: sid, message: '再来', cwd: HOME });
    const ts2 = ev2.find(e => e.type === 'turn_summary');
    const result2 = [...ev2].reverse().find(e => e.type === 'result');
    ok(!!ts2, 'turn2: turn_summary emitted (fresh turn works)');
    ok(!!result2, 'turn2: result event emitted (fresh turn works)');
    // The 2nd turn's first tool_result must NOT already carry loopWarning (counter was reset at turn start).
    const tr2 = ev2.filter(e => e.type === 'tool_result');
    ok(!(tr2[0] && tr2[0].content && tr2[0].content.loopWarning), 'turn2: 1st tool_result has NO loopWarning (counter reset across turns)');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nLOOP-GUARD E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
