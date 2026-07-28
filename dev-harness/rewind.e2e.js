(async () => {
// E2E (v0.8-S4b): conversation REWIND on the provider engine (fake-openai, offline). Covers:
//  (a) 3 turns: t1 plain chat, t2 = FAKE_TOOL_SEQUENCE file_write NEW b.txt (journaled create), t3 plain
//      chat. Then POST /api/session/rewind {targetTurnSeq: t2, rollbackFiles:true} → assert:
//       - session.messages keep ONLY t1's user+assistant (everything from t2's user onward removed);
//       - lastUserText === t2's original user text (refilled into composer client-side);
//       - providerHistory length === 0 (cleared — lazy-reseed rebuilds it next turn);
//       - b.txt (written in t2) no longer exists (journal create inverse = delete);
//       - filesReverted includes b.txt.
//  (b) send a NEW turn after the rewind → normal reply (lazy reseed works) AND the new turnSeq keeps
//      incrementing (NOT rewound — monotonic journal key).
//  (c) rewind with NO UI token → 403.
//  (d) 第69波:live-turn rewind — 旧行为直接拒「回合进行中,请先停止」(非 UI 持有回合死锁 + dying turn
//      收尾 save 盖回截断的丢失写);现自动 stopSession('rewind') + 等 turnSettlers settle 再截断。
//      FAKE_STREAM_DELAY_MS 把回合确定性摁在「进行中」窗口驱动回归。
//  (e) 第69波静态锁:sendPrompt 乐观 user 行(合成对象,无 turnSeq/不在 messages)的操作条在回合拿到
//      持久化真身后重绑 —— 否则其「回溯到此处」必弹「无法定位该消息的回合」(用户线上报告)。
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-rewind-e2e');
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p, headers) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000, headers: headers || {} }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { resolve({ status: resp.statusCode, body: JSON.parse(b) }); } catch (e) { reject(new Error('bad json: ' + b)); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
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
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
function fakeReachable() { return new Promise(resolve => { const net = require('net'); const s = net.connect({ host: '127.0.0.1', port: FAKE_PORT }, () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); s.setTimeout(500, () => { s.destroy(); resolve(false); }); }); }
async function waitFakeUp() { for (let i = 0; i < 50; i++) { if (await fakeReachable()) return true; await sleep(100); } return false; }
async function waitFakeDown() { for (let i = 0; i < 50; i++) { if (!await fakeReachable()) return true; await sleep(100); } return false; }
function writeConfig(home, fakePort) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
    activeProvider: 'fake',
  }, null, 2));
}
// Spawn a fake-openai (optionally with a FAKE_TOOL_SEQUENCE) for one turn, then it's killed by the caller.
function spawnFake(seq, extraEnv) {
  const env = { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), ...(extraEnv || {}) };
  if (seq) env.FAKE_TOOL_SEQUENCE = JSON.stringify(seq);
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env, windowsHide: true });
  fake.stdout.on('data', () => {});
  return fake;
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const bTxt = path.join(HOME, 'b.txt');
  writeConfig(HOME, FAKE_PORT);
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  procs.push(wb);

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');

    const created = await postJson(WB_PORT, '/api/sessions', { title: 'rewind test', cwd: HOME });
    const sid = created.body.session && created.body.session.id;
    ok(!!sid, 'session created');

    const T2_TEXT = 'turn two: please create b.txt';

    // ---- turn 1: plain chat (no tools) ----
    const f1 = spawnFake(null); procs.push(f1);
    ok(await waitFakeUp(), 'fake up (t1)');
    await postStream(WB_PORT, { sessionId: sid, message: 'turn one hello', cwd: HOME });
    killp(f1); await waitFakeDown();

    // ---- turn 2: FAKE_TOOL_SEQUENCE file_write NEW b.txt ----
    const f2 = spawnFake([{ name: 'file_write', args: { path: bTxt, content: 'created-in-t2' } }]); procs.push(f2);
    ok(await waitFakeUp(), 'fake up (t2)');
    await postStream(WB_PORT, { sessionId: sid, message: T2_TEXT, cwd: HOME });
    killp(f2); await waitFakeDown();
    ok(fs.existsSync(bTxt) && fs.readFileSync(bTxt, 'utf8') === 'created-in-t2', 't2 created b.txt');

    // ---- turn 3: plain chat ----
    const f3 = spawnFake(null); procs.push(f3);
    ok(await waitFakeUp(), 'fake up (t3)');
    await postStream(WB_PORT, { sessionId: sid, message: 'turn three followup', cwd: HOME });
    killp(f3); await waitFakeDown();

    // Snapshot pre-rewind: turnSeq should be 3; messages should be 6 (3 user + 3 assistant).
    const pre = (await getJson(WB_PORT, '/api/sessions/' + sid)).body.session;
    ok(pre.turnSeq === 3, 'pre-rewind turnSeq === 3 (got ' + pre.turnSeq + ')');
    ok((pre.messages || []).length === 6, 'pre-rewind 6 messages (got ' + (pre.messages || []).length + ')');
    // The t2 user message must carry the additive turnSeq stamp === 2.
    const t2user = (pre.messages || []).find(m => m.role === 'user' && m.content === T2_TEXT);
    ok(t2user && Number(t2user.turnSeq) === 2, 't2 user message stamped turnSeq === 2');

    // ============ (a) rewind to turnSeq 2 with rollbackFiles:true ============
    const rw = (await postJson(WB_PORT, '/api/session/rewind', { sessionId: sid, targetTurnSeq: 2, rollbackFiles: true }, { 'x-wcw-token': token })).body;
    ok(rw.ok === true, '(a) rewind ok');
    ok(rw.lastUserText === T2_TEXT, '(a) lastUserText === t2 original text');
    ok(rw.removedTurns === 4, '(a) removedTurns === 4 (t2 user+assistant + t3 user+assistant) (got ' + rw.removedTurns + ')');
    ok(Array.isArray(rw.filesReverted) && rw.filesReverted.some(f => f.path === bTxt), '(a) filesReverted includes b.txt');
    ok(!fs.existsSync(bTxt), '(a) b.txt removed by rollback (create inverse = delete)');

    const post = (await getJson(WB_PORT, '/api/sessions/' + sid)).body.session;
    ok((post.messages || []).length === 2, '(a) only t1 user+assistant remain (2 messages, got ' + (post.messages || []).length + ')');
    ok((post.messages || [])[0].role === 'user' && (post.messages || [])[0].content === 'turn one hello', '(a) surviving first message is t1 user');
    ok(Array.isArray(post.providerHistory) && post.providerHistory.length === 0, '(a) providerHistory cleared to [] (got ' + (post.providerHistory || []).length + ')');
    ok(post.turnSeq === 3, '(a) turnSeq NOT rewound — still 3 (got ' + post.turnSeq + ')');

    // ============ (b) new turn after rewind: lazy reseed works + turnSeq keeps incrementing ============
    const f4 = spawnFake(null); procs.push(f4);
    ok(await waitFakeUp(), 'fake up (post-rewind turn)');
    const ev4 = await postStream(WB_PORT, { sessionId: sid, message: 'after rewind, continue', cwd: HOME });
    killp(f4); await waitFakeDown();
    const res4 = ev4.find(e => e.type === 'result');
    ok(res4 && res4.ok === true, '(b) post-rewind turn produced a normal (ok) result');
    const post2 = (await getJson(WB_PORT, '/api/sessions/' + sid)).body.session;
    ok(post2.turnSeq === 4, '(b) new turnSeq === 4 (incremented, not reused) (got ' + post2.turnSeq + ')');
    // Lazy reseed: providerHistory rebuilt from messages (t1 pair + reseeded) then this turn appended.
    ok((post2.providerHistory || []).length >= 2, '(b) providerHistory rebuilt by lazy reseed (len ' + (post2.providerHistory || []).length + ')');

    // ============ (c) rewind with NO UI token → 403 ============
    const noTok = await postJson(WB_PORT, '/api/session/rewind', { sessionId: sid, targetTurnSeq: 1 });
    ok(noTok.status === 403, '(c) rewind without UI token → 403 (got ' + noTok.status + ')');

    // ============ (d) 第69波:活回合 rewind = 自动停回合 + 等 settle,无丢失写 ============
    // 旧行为:activeChildren.has → 直接拒「回合进行中,请先停止」——非 UI 持有的回合(页面重载/后台
    // 调度)下前端没有停止按钮,用户永远「回不去」;且 stop 后 dying turn 的收尾 saveSession 会把 rewind
    // 的截断整份盖回(丢失写:消息「回来了」)。现:rewind 自动 stopSession('rewind') + 等 turnSettlers
    // settle(driver finally,收尾 save 之后)再截断。
    const beforeD = (await getJson(WB_PORT, '/api/sessions/' + sid)).body.session;
    const msgsBeforeD = (beforeD.messages || []).length;
    const f5 = spawnFake(null, { FAKE_STREAM_DELAY_MS: '3000' }); procs.push(f5);
    ok(await waitFakeUp(), '(d) fake up (FAKE_STREAM_DELAY_MS=3000)');
    const liveTurn = postStream(WB_PORT, { sessionId: sid, message: 'slow turn interrupted by rewind', cwd: HOME });
    await sleep(700); // 请求已到 fake 且被 delay 摁住 —— 回合钉在「进行中」窗口
    const rwLive = (await postJson(WB_PORT, '/api/session/rewind', { sessionId: sid, targetTurnSeq: Number(beforeD.turnSeq) + 1 }, { 'x-wcw-token': token })).body;
    ok(rwLive && rwLive.ok === true, '(d) 活回合 rewind ok=true — 自动停回合(旧:回合进行中拒绝;实 ' + JSON.stringify(rwLive && { ok: rwLive.ok, error: rwLive.error }) + ')');
    await liveTurn.catch(() => {}); // 被停回合的流收尾(abort → driver finally → settle;rewind 已等过)
    killp(f5); await waitFakeDown();
    await sleep(400);
    const postD = (await getJson(WB_PORT, '/api/sessions/' + sid)).body.session;
    ok((postD.messages || []).length === msgsBeforeD, '(d) 截断不被 dying turn 收尾盖回 — 消息仍 ' + msgsBeforeD + ' 条(实 ' + (postD.messages || []).length + ';丢失写则回弹)');
    ok(!(postD.messages || []).some(m => m && m.role === 'user' && m.content === 'slow turn interrupted by rewind'), '(d) 被停回合的 user 消息已随截断移除');

    // ============ (e) 第69波静态锁:乐观 user 行操作条重绑(「无法定位该消息的回合」修复) ============
    // sendPrompt 乐观渲染的 user 行是合成对象(无 turnSeq、不在 session.messages),其「回溯到此处」
    // 必弹「无法定位该消息的回合」;回合拿到持久化真身后必须重绑操作条。
    const rtSrc = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'chat-stream-runtime.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(WB, 'app', 'public', 'app.js'), 'utf8');
    ok(/const optimisticUserRow = renderStaticMessage\(/.test(rtSrc), '(e) 乐观 user 行引用被捕获(optimisticUserRow)');
    ok(/rebindOptimisticUserRow = sess =>/.test(rtSrc) && /bar\.replaceWith\(msgActions\(real\)\)/.test(rtSrc), '(e) rebindOptimisticUserRow 用真身重建 msgActions');
    ok((rtSrc.match(/rebindOptimisticUserRow\(/g) || []).length >= 2, '(e) 成功路径与失败路径都调重绑(>=2 处调用)');
    ok(/msgActions: \(\.\.\.args\) => msgActions\(\.\.\.args\),/.test(appSrc), '(e) app.js 把 msgActions 注入 stream runtime deps');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) killp(c);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nREWIND E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
