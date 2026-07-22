(async () => {
// E2E (第51波 51b / 02 Phase B): between-tools steer 中断(配对安全)。
// FAKE_PARALLEL_TOOLS=3 file_read(一个 assistant 消息 3 tool_call)+ STREAM_DELAY=150 拉长流窗口,
// steer 在流期间到达 reg.steerQueue -> 第一个工具完成后 between-tools 检查(line 1623)中断剩余 2 个
// (补配对 refusal),外层 continue 回 drainSteerQueue 注入插话(Codex 级立即生效)。
// 验证: f1 真实执行 + f2/f3 refusal("用户插话中断") + 配对块连续(3 tool_call -> 3 role:tool 不劈)
// + 插话在配对块后。与 steering.e2e ⑦(测配对块后注入,断言不区分真实/refusal)互补: 本件明确断言
// between-tools 中断的 refusal 标志。
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-51b-interrupt');
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const STEER_TEXT = '改做其他事';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p, headers) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000, headers: headers || {} }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b)); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
function postJson(port, p, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let parsed = null; try { parsed = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, body: parsed }); }); });
    req.on('error', reject); req.write(data); req.end();
  });
}
function streamChatLive(port, payload, onEvent) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { let evt = null; try { evt = JSON.parse(line); } catch { /* ignore */ } if (evt) { events.push(evt); try { onEvent(evt); } catch { /* ignore */ } } } } });
      res.on('end', () => { if (buf.trim()) { try { const evt = JSON.parse(buf); events.push(evt); onEvent(evt); } catch { /* ignore */ } } resolve(events); });
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
function checkToolBlockContiguity(ph) {
  for (let i = 0; i < ph.length; i++) {
    const m = ph[i];
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const ids = m.tool_calls.map(t => t.id).slice().sort();
      const replies = ph.slice(i + 1, i + 1 + ids.length);
      if (replies.length !== ids.length) return { ok: false, at: i, why: 'short block' };
      if (!replies.every(r => r && r.role === 'tool')) return { ok: false, at: i, why: 'non-tool wedged in block' };
      const rids = replies.map(r => r.tool_call_id).slice().sort();
      if (JSON.stringify(ids) !== JSON.stringify(rids)) return { ok: false, at: i, why: 'id set mismatch' };
    }
  }
  return { ok: true };
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const f1 = path.join(HOME, 'f1.txt'), f2 = path.join(HOME, 'f2.txt'), f3 = path.join(HOME, 'f3.txt');
  fs.writeFileSync(f1, 'content-1'); fs.writeFileSync(f2, 'content-2'); fs.writeFileSync(f3, 'content-3');
  writeConfig(HOME, FAKE_PORT);
  // 3 个 file_read 在一个 assistant 消息(parallel batch)。STREAM_DELAY=150 拉长流窗口让 steer 在流期间到达。
  const par = JSON.stringify([{ name: 'file_read', args: { path: f1 } }, { name: 'file_read', args: { path: f2 } }, { name: 'file_read', args: { path: f3 } }]);
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_PARALLEL_TOOLS: par, FAKE_STREAM_DELAY_MS: '150' }, windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  procs.push(fake, wb);

  try {
    let h = null; for (let i = 0; i < 40 && !h; i += 1) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    ok(!!token, 'token acquired');
    const created = await postJson(WB_PORT, '/api/sessions', { title: '51b interrupt', cwd: HOME }, { 'x-wcw-token': token });
    const sid = created.body && created.body.session && created.body.session.id;
    ok(!!sid, 'session created');

    // steer 在 meta 事件后 250ms POST(同 steering ⑦:流期间到达 reg.steerQueue,早于第一个工具完成)。
    let steerResp = null;
    const ev = await streamChatLive(WB_PORT, { sessionId: sid, message: '并行读三个文件', cwd: HOME }, evt => {
      if (evt.type === 'meta' && !steerResp) {
        steerResp = { pending: true };
        setTimeout(() => { postJson(WB_PORT, '/api/steer', { sessionId: sid, text: STEER_TEXT }, { 'x-wcw-token': token }).then(r => { steerResp = r; }).catch(() => {}); }, 250);
      }
    });
    for (let i = 0; i < 20 && !(steerResp && steerResp.body); i += 1) await sleep(50);
    ok(steerResp && steerResp.body && steerResp.body.ok === true, 'steer accepted (got ' + JSON.stringify(steerResp && steerResp.body) + ')');

    const toolUses = ev.filter(e => e.type === 'tool_use');
    const toolResults = ev.filter(e => e.type === 'tool_result');
    ok(toolUses.length === 3, '3 tool_use (f1/f2/f3, got ' + toolUses.length + ')');
    // between-tools 中断标志: f2/f3 refusal("用户插话中断")
    const refusals = toolResults.filter(r => r.content && r.content.error && /用户插话中断/.test(r.content.error));
    ok(refusals.length === 2, '2 refusal tool_result (f2/f3 between-tools 中断, got ' + refusals.length + ')');
    const realResults = toolResults.filter(r => r.content && r.content.ok !== false && !(r.content && r.content.error && /用户插话中断/.test(r.content.error)));
    ok(realResults.length === 1, '1 real tool_result (f1 执行, got ' + realResults.length + ')');
    ok(!!ev.find(e => e.type === 'steered' && e.text === STEER_TEXT), 'steered event streamed');
    ok(!!ev.find(e => e.type === 'turn_summary'), 'turn_summary (回合正常结束, between-tools 中断不 abort)');
    ok(!!ev.find(e => e.type === 'result'), 'result event');

    // providerHistory 配对块连续 + 插话在块后
    const got = await getJson(WB_PORT, '/api/sessions/' + sid, { 'x-wcw-token': token });
    const ph = (got.session && got.session.providerHistory) || [];
    const contig = checkToolBlockContiguity(ph);
    ok(contig.ok, '配对块连续 (3 tool_call -> 3 role:tool 不劈)' + (contig.ok ? '' : ' (' + contig.why + ' @' + contig.at + ')'));
    const batchIdx = ph.findIndex(m => m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length === 3);
    const steerIdx = ph.findIndex(m => m && m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[用户插话] '));
    ok(batchIdx >= 0 && steerIdx === batchIdx + 4, '插话在配对块后 (assistant(3 tc)+3 tool replies+插话, batch@' + batchIdx + ' steer@' + steerIdx + ')');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nSTEER-INTERRUPT E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
