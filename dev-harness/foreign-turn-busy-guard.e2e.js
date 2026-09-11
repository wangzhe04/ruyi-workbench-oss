#!/usr/bin/env node
'use strict';
// E2E(第 117 波 117s-G · 27 号文 §11.13.1 ②):【别处起的回合】不许被一句新话顶掉。
//
// 复现的事故(真浏览器,§11.13.1 ② 逐条记着):管家开的线程正在跑(回合是 stewardLaunchTurn 在服务端
// 起的,没有任何客户端挂在它的流上),用户在经典壳的「2.0 视窗」里打一句话按发送 ——
//   POST /api/chat/stream → 09:1347 `if (activeChildren.has) stopSession('superseded')`
//   → turn_start seq=1 / turn_kill reason:'superseded' / turn_start seq=2,
// 第一回合几分钟的工作连同正文一起没了,界面零提示。
//
// 本件只测服务端那一半(浏览器那一半在 classic-window-live-steer.e2e.js 的 H 段;
// 121-K5:原来指的 steward-classic-window.e2e.js 随「2.0 视窗」整段退役):
//   (A) 后备闸:活回合是 source:'steward' 起的 → 同一条会话的 POST /api/chat/stream 回 409
//       session.turn_busy_elsewhere;零 turn_kill;第一回合跑完、正文完整;会话里只有一条 user 消息。
//   (B) 信封:活回合在跑时 GET /api/sessions/:id 带 relay:{channel:'steer'};回合一结束这个键就不在了
//       (空闲会话的信封逐字节与修前相同 —— 存量消费者不受影响)。
//   (C) 既有语义没被动过:同一个发起面(经典壳自己)连发两次,第二次照旧 supersede 第一次。
//
// 判定行:`FOREIGN TURN BUSY GUARD E2E: ALL PASS`。
(async () => {
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-foreign-busy-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } } }

const PROVIDER_PORT = await getFreePort();
const WB_PORT = await getFreePort();
const sessionsDir = path.join(HOME, 'sessions');
const logsDir = path.join(HOME, 'logs');

// ── fake provider ────────────────────────────────────────────────────────────────────────────
// 'SLOW' → 分三段流出,整趟约 SLOW_MS;别的 → 一句话就收。管家会话恒回结构化契约 JSON。
// providerAborted 记「上游把请求掐了」—— 断言「那个回合的 provider 请求【没有】被中止」靠它。
const SLOW_MS = 9000;
let providerAborted = 0;
const providerServer = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if ((req.url || '').includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"data":[{"id":"fake-model"}]}');
  }
  let body = {}; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const sys = messages.filter(m => m && m.role === 'system').map(m => String(m.content || '')).join('\n');
  const isSteward = /我是如意/.test(sys);
  const users = messages.filter(m => m && m.role === 'user').map(m => String(m.content || ''));
  const lastUser = users.length ? users[users.length - 1] : '';
  // 「上游把这一发掐了」的判据用 res 的 close:请求体早就读完了,'aborted' 不会再响;
  // 回合被 stopSession 杀掉时断的是【响应】那一端,只有 res 的 close 抓得住(反向验证时实测)。
  let aborted = false;
  let finished = false;
  res.on('close', () => { if (!finished) { aborted = true; providerAborted += 1; } });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const sse = v => { try { res.write('data: ' + JSON.stringify(v) + '\n\n'); } catch { /* client gone */ } };
  const done = () => { finished = true; try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* client gone */ } };

  if (isSteward) {
    sse({ choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify({ say: '看过了。', why: '总览', acts: [], actions: [] }) }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    return done();
  }
  if (/SLOW/.test(lastUser)) {
    sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '慢慢来-第一段' }, finish_reason: null }] });
    await sleep(Math.floor(SLOW_MS / 2));
    if (aborted) return;
    sse({ choices: [{ index: 0, delta: { content: '-第二段' }, finish_reason: null }] });
    await sleep(Math.floor(SLOW_MS / 2));
    if (aborted) return;
    sse({ choices: [{ index: 0, delta: { content: '-收尾' }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } });
    return done();
  }
  sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '好的,记下了。' }, finish_reason: null }] });
  sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } });
  return done();
});
await new Promise(r => providerServer.listen(PROVIDER_PORT, '127.0.0.1', r));

fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, activeProvider: 'fake', engineMode: 'interactive',
  permissionMode: 'default', permissionTimeoutMs: 120000, questionTimeoutMs: 120000,
  includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [],
  subagentMaxPerTurn: 0, killOnDisconnect: false, locale: 'zh-CN',
  stewardEnabledV1: true, stewardPollMs: 120000, stewardReadBudgetChars: 4000,
  stewardMaxTurnsPerHour: 500, stewardMaxCostPerDay: 0,
  stewardGlobalMaxTurnsPerHour: 2000, stewardGlobalMaxCostPerDay: 0,
  stewardProviderId: 'fake', stewardModel: 'fake-model', stewardThreadBriefV1: false,
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
}, null, 2), 'utf8');

function request(method, p, body, headers) {
  return new Promise(resolve => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: WB_PORT, path: p, method, timeout: 60000,
      headers: { ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}), ...(headers || {}) },
    }, res => {
      let b = ''; res.on('data', c => { b += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { json = null; } resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', () => resolve({ status: 0, json: null, raw: '' }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '' }); });
    if (raw) r.write(raw);
    r.end();
  });
}
async function waitUp() { // 30 号文 P1-31:健康门预算 300×120ms
  for (let i = 0; i < 300; i++) { const h = await request('GET', '/health'); if (h.status === 200) return true; await sleep(120); }
  return false;
}
async function tokenOf() {
  const html = await new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/' }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b)); });
    r.on('error', () => resolve(''));
  });
  return (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
}
function auditRows() {
  const out = [];
  for (const f of (fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [])) {
    if (!f.endsWith('.ndjson')) continue;
    for (const line of fs.readFileSync(path.join(logsDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return out;
}
const killsOf = sid => auditRows().filter(r => r && r.kind === 'turn_kill' && r.sessionId === sid);
const sessionMessages = id => {
  try {
    return fs.readFileSync(path.join(sessionsDir, id + '.messages.ndjson'), 'utf8').split('\n')
      .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

let hdr = {};
let wb = null;
try {
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true,
  });
  wb.stdout.on('data', () => {});
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  ok(await waitUp(), 'A0 工作台启动');
  hdr = { 'x-wcw-token': await tokenOf() };
  // 建管家会话(唯一合法方式)—— /api/steward/relay 要它在。
  await request('POST', '/api/steward/message', { message: '现在什么情况' }, hdr);

  let wsSeq = 0;
  const newThread = async title => {
    const cwd = path.join(HOME, 'ws', 'w' + (++wsSeq));
    fs.mkdirSync(cwd, { recursive: true });
    const created = await request('POST', '/api/sessions', { title, cwd }, hdr);
    return created.json && created.json.session && created.json.session.id;
  };
  const cwdOf = sid => { try { return String(JSON.parse(fs.readFileSync(path.join(sessionsDir, sid + '.json'), 'utf8')).cwd || HOME); } catch { return HOME; } };
  // 不等回合结束地经【经典壳那条路】起一个回合(source 恒为 'http')。
  const fireClassicTurn = (sessionId, message) => {
    const body = JSON.stringify({ sessionId, message, cwd: cwdOf(sessionId) });
    const r = http.request({
      host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', timeout: 120000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...hdr },
    }, res => { res.on('data', () => {}); res.on('end', () => {}); });
    r.on('error', () => {});
    r.write(body); r.end();
    return r;
  };
  const envelope = sid => request('GET', `/api/sessions/${encodeURIComponent(sid)}`, undefined, hdr);
  const waitLive = async (sid, want = true) => {
    for (let i = 0; i < 300; i++) {
      const res = await envelope(sid);
      const live = !!(res.json && res.json.resumable && res.json.resumable.live === true);
      if (live === want) return res;
      await sleep(100);
    }
    return null;
  };

  /* ═════════ (A) 后备闸:别处起的活回合 → 409 忙,不杀 ═════════ */
  console.log('── (A) 管家起的回合在跑时,经典壳发一句话 ──');
  let sidA = '';
  {
    sidA = await newThread('管家派出去的线程');
    // source:'steward' 的回合。/api/steward/relay → 13h relayDeliver(空闲 → turn 通道)
    // → 13g stewardLaunchTurn({ source: 'steward' }),与真实管家派活逐字同一条路。
    const relayed = await request('POST', '/api/steward/relay', { sessionId: sidA, message: 'SLOW 帮我把这件事做完' }, hdr);
    ok(!!(relayed.json && relayed.json.ok === true && relayed.json.channel === 'turn'),
      `A1 管家起了一个回合(channel=${relayed.json && relayed.json.channel} status=${relayed.status})`);
    const liveEnv = await waitLive(sidA, true);
    ok(!!liveEnv, 'A2 那个回合真的在跑(信封 resumable.live === true)');

    const abortedBefore = providerAborted;
    const killsBefore = killsOf(sidA).length;
    // 这就是用户在 2.0 视窗里按下发送的那一发。
    const blocked = await request('POST', '/api/chat/stream', { sessionId: sidA, message: '顺便看一下 B', cwd: cwdOf(sidA) }, hdr);
    ok(blocked.status === 409, `A3 回 409 而不是开跑(got ${blocked.status})`);
    const err = blocked.json && blocked.json.error;
    ok(!!(err && err.code === 'session.turn_busy_elsewhere'),
      `A4 稳定错误码 session.turn_busy_elsewhere(got ${err && err.code})`);
    ok(!!(err && err.params && err.params.turnSource === 'steward'),
      `A5 信封说清「这个回合是谁起的」(turnSource=${err && err.params && err.params.turnSource})`);
    ok(!!(err && String(err.message || '').length > 0), 'A6 带一句人话');
    ok(killsOf(sidA).length === killsBefore, `A7 零 turn_kill —— 那个回合一根汗毛没动(before=${killsBefore} after=${killsOf(sidA).length})`);
    ok(providerAborted === abortedBefore, `A8 上游 provider 请求【没有】被中止(aborted ${abortedBefore} → ${providerAborted})`);

    const endedEnv = await waitLive(sidA, false);
    ok(!!endedEnv, 'A9 第一个回合自己跑到收尾');
    const msgs = sessionMessages(sidA);
    const userMsgs = msgs.filter(m => m && m.role === 'user');
    const assistant = msgs.filter(m => m && m.role === 'assistant');
    ok(userMsgs.length === 1, `A10 会话里只有管家那一条 user 消息(被拒的那句一个字都没落盘;got ${userMsgs.length})`);
    ok(assistant.some(m => /慢慢来-第一段-第二段-收尾/.test(String(m.content || ''))),
      `A11 那个回合的正文【完整】落盘(got ${JSON.stringify((assistant[0] || {}).content || '').slice(0, 80)})`);
    const kills = killsOf(sidA);
    ok(kills.length === 0, `A12 全程零 turn_kill(got ${JSON.stringify(kills.map(k => k.reason))})`);
  }

  /* ═════════ (B) 信封上的 relay ═════════ */
  console.log('── (B) GET /api/sessions/:id 的 relay 键 ──');
  {
    const idle = await envelope(sidA);
    ok(!!(idle.json && idle.json.ok === true) && idle.json.relay === undefined,
      `B1 空闲会话的信封里【没有】relay 键(存量消费者逐字节不受影响;got ${JSON.stringify(idle.json && idle.json.relay)})`);

    const sidB = await newThread('看信封的线程');
    await request('POST', '/api/steward/relay', { sessionId: sidB, message: 'SLOW 再来一趟' }, hdr);
    const liveEnv = await waitLive(sidB, true);
    ok(!!(liveEnv && liveEnv.json && liveEnv.json.relay && liveEnv.json.relay.channel === 'steer'),
      `B2 活回合在跑时 relay.channel === 'steer'(13h stewardRelayChannelFor 的原判,不是第二套判据;got ${JSON.stringify(liveEnv && liveEnv.json && liveEnv.json.relay)})`);
    const after = await waitLive(sidB, false);
    ok(!!after && after.json.relay === undefined,
      `B3 回合一结束 relay 键就不在了(got ${JSON.stringify(after && after.json.relay)})`);
  }

  /* ═════════ (C) 既有语义:同一个发起面连发两次,照旧 supersede ═════════ */
  console.log('── (C) 经典壳自己连发两次:既有 supersede 语义一字不动 ──');
  {
    const sidC = await newThread('同一扇窗连发两次');
    fireClassicTurn(sidC, 'SLOW 第一句');
    ok(!!(await waitLive(sidC, true)), 'C1 第一个回合在跑');
    const before = killsOf(sidC).length;
    fireClassicTurn(sidC, '第二句');
    let killed = null;
    for (let i = 0; i < 300; i++) {
      const rows = killsOf(sidC);
      if (rows.length > before) { killed = rows[rows.length - 1]; break; }
      await sleep(100);
    }
    ok(!!(killed && killed.reason === 'superseded'),
      `C2 同一个发起面(source 都是 'http')照旧 supersede —— 这条既有语义没被动过(got ${killed && killed.reason})`);
    ok(!!(await waitLive(sidC, false)), 'C3 第二个回合跑完');
    ok(sessionMessages(sidC).some(m => m && m.role === 'assistant' && /记下了/.test(String(m.content || ''))),
      'C4 第二句的正文落盘(顶替是成功的,不是双双失败)');
  }
} catch (error) {
  console.log('ERROR ' + (error && error.stack || error));
  fail += 1;
} finally {
  kill(wb);
  await new Promise(r => providerServer.close(r));
  await sleep(200);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* windows lock */ }
  console.log(`\nFOREIGN TURN BUSY GUARD E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
