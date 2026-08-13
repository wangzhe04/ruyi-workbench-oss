(async () => {
// E2E (v2.6 loop guard 分层): read 工具同签名连击「只 warn 不 abort」+ 轮询原语「完全豁免」。
// 与 loop-guard.e2e.js 互补: 后者用 file_write(edit tier)验证「有副作用工具 5 次 abort 仍生效」;
// 本件验证无副作用工具不再被 abort 整回合 —— 对症「wait_agents 反复轮询被误杀」与「查文件多次调用被误杀」。
//
// A 段(read 豁免): file_read{path: <same>} 重复 6 次 → 第 3 次起 loopWarning,但【不 abort】,6 次全执行,
//   结果 errorClass !== 'tool_loop'(正常结束)。
// B 段(轮询豁免): 同一 wait_agents(无 runId)重复 6 次 → 连 loopWarning 都不该出现(轮询原语完全豁免)。
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-loop-guard-read-exempt-e2e');
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
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass', subagentMaxPerTurn: 4,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
    activeProvider: 'fake',
  }, null, 2));
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const target = path.join(HOME, 'read-me.txt');
  fs.writeFileSync(target, 'read exempt fixture content');
  writeConfig(HOME, FAKE_PORT);

  // ---- A 段: file_read 重复 6 次(read tier → 只 warn 不 abort) ----
  const stepA = { name: 'file_read', args: { path: target } };
  const seqA = JSON.stringify([stepA, stepA, stepA, stepA, stepA, stepA]);
  const fakeA = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_SEQUENCE: seqA }, windowsHide: true });
  const wbA = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  procs.push(fakeA, wbA);

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);
    const created = await postJson(WB_PORT, '/api/sessions', { title: 'read-exempt', cwd: HOME });
    const sid = created.session && created.session.id;
    ok(!!sid, 'session created');

    const ev1 = await postStream(WB_PORT, { sessionId: sid, message: '开始', cwd: HOME });
    const toolResults = ev1.filter(e => e.type === 'tool_result');
    const toolUses = ev1.filter(e => e.type === 'tool_use');

    // A: 6 次全执行(read 不 abort)
    ok(toolUses.length === 6, 'A: 6 tool_use 全执行(read 不 abort, got ' + toolUses.length + ')');
    // A: 第 3 次起有 loopWarning(仍 warn 提示)
    const third = toolResults[2];
    ok(third && third.content && typeof third.content.loopWarning === 'string' && /第 3 次/.test(third.content.loopWarning),
      'A: 第 3 次 loopWarning(仍 warn, got ' + (third && third.content && third.content.loopWarning) + ')');
    // A: 无 loopAborted 拒绝
    ok(!toolResults.some(t => t && t.content && t.content.loopAborted === true), 'A: 无 loopAborted 拒绝(read 不 abort)');
    // A: errorClass !== tool_loop
    const result1 = [...ev1].reverse().find(e => e.type === 'result');
    ok(!(result1 && result1.errorClass === 'tool_loop'), 'A: errorClass 非 tool_loop(read 不 abort, got ' + (result1 && result1.errorClass) + ')');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
  }

  // ---- B 段: wait_agents 重复 6 次(轮询原语 → 完全豁免,连 warn 都不该有) ----
  // 注意: wait_agents 需要 spawnAgentEnabled(subagentMaxPerTurn>0),config 已设 4。fake 序列重复相同 wait_agents。
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  writeConfig(HOME, FAKE_PORT);
  const stepB = { name: 'wait_agents', args: {} };
  const seqB = JSON.stringify([stepB, stepB, stepB, stepB, stepB, stepB]);
  const fakeB = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_SEQUENCE: seqB }, windowsHide: true });
  const wbB = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  procs.push(fakeB, wbB);

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up (B) on :' + WB_PORT);
    const created = await postJson(WB_PORT, '/api/sessions', { title: 'polling-exempt', cwd: HOME });
    const sid = created.session && created.session.id;
    ok(!!sid, 'session created (B)');

    const ev2 = await postStream(WB_PORT, { sessionId: sid, message: '开始', cwd: HOME });
    const toolResults = ev2.filter(e => e.type === 'tool_result');
    const toolUses = ev2.filter(e => e.type === 'tool_use');

    // B: 6 次全执行(轮询原语不 abort)
    ok(toolUses.length === 6, 'B: 6 tool_use 全执行(轮询原语不 abort, got ' + toolUses.length + ')');
    // B: 无 loopWarning(完全豁免,连 warn 都不该有)
    ok(!toolResults.some(t => t && t.content && typeof t.content.loopWarning === 'string'),
      'B: 无 loopWarning(轮询原语完全豁免)');
    // B: 无 loopAborted
    ok(!toolResults.some(t => t && t.content && t.content.loopAborted === true), 'B: 无 loopAborted(轮询原语豁免)');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nLOOP-GUARD READ-EXEMPT E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
