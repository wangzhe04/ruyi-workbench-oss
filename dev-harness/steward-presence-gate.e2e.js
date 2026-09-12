#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）

// E2E(第 121 波 K3 · 34 号文 §4.3 / §4.5):在场门与「管家对你正坐着的线程」。
//
// K2a 已经让每条 SSE 连接自报 `?lens=&sessionId=`(在场信号),但**没有任何人读它** ——
// 13r 的注释原话是「本刀只产出这份事实,不接任何门」。K3 把它接上两处:
//   ① 收件箱的打扰纪律(§4.3):用户就坐在这条线程前面时,它的 needs_you 不该再变成一张卡片去戳他;
//   ② 管家的工具门(§4.5):不代答你正在看的那条线程的提问、不往里递话、不改它的权限。
//
// 本件用【真 SSE 连接建在场 + 真线程 + 真待决】证伪四条在场情形与工具门:
//   P1 坐在 X 上:X 的 needs_you【不】生成收件箱行(索引与 /api/missions 照常有它);
//   P2 坐在 Y 上:X 的 needs_you 进收件箱,并且打上 quiet:true(前端安静卡读它);
//   P3 在管家视角:今天的行为,一个字不改(needs_you 照常进箱,且【不】打 quiet);
//   P4 没有连接:今天的行为(累积);
//   S  seatedBy:/api/missions 行上的 seatedBy 随在场变化('user' / null);
//   T  工具门:steward_thread_continue / steward_thread_permission / steward_decide 对 X 一律
//      返回结构化拒绝 `seated_by_user`;拔掉在场(断连)之后同一次调用不再被拒。
//
// 夹具:temp HOME + 假 OpenAI 兼容 provider(同 event-stream.e2e.js 那一套),不开浏览器。
// 判定行:`STEWARD PRESENCE GATE E2E: ALL PASS`。
(async () => {
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const POLL_MS = 5000;          // 收件箱一拍(13i 允许的最小值)
const TICK_WAIT = POLL_MS * 2 + 2500;

function request(port, method, pathname, body, token) {
  return new Promise(resolve => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: 60000,
      headers: {
        ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
        ...(token ? { 'x-wcw-token': token } : {}),
      },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-json */ }
        resolve({ status: response.statusCode, text, json });
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (raw) req.write(raw);
    req.end();
  });
}

async function waitForHttp(port, method, pathname, predicate, token, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    const result = await request(port, method, pathname, null, token);
    if (result && predicate(result)) return result;
    await sleep(100);
  }
  return null;
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* already exited */ }
}

// ── 在场连接。只要连上就算在场;close() 即「离开壳」(13r 按连接生死记在场)。──────────
function openPresence(port, token, lens, sessionId) {
  const state = { frames: [], closed: false, status: 0, req: null };
  let buffer = '';
  state.ready = new Promise(resolve => {
    const query = '?lens=' + encodeURIComponent(lens) + (sessionId ? '&sessionId=' + encodeURIComponent(sessionId) : '');
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/events/stream' + query, method: 'GET',
      headers: { ...(token ? { 'x-wcw-token': token } : {}) },
    }, response => {
      state.status = response.statusCode;
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (!block.trim() || block.startsWith(':')) continue;
          const frame = { event: '', data: null };
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) { try { frame.data = JSON.parse(line.slice(6)); } catch { frame.data = null; } }
          }
          state.frames.push(frame);
        }
      });
      response.on('end', () => { state.closed = true; });
      resolve(state);
    });
    req.on('error', () => { state.closed = true; resolve(state); });
    state.req = req;
    req.end();
  });
  state.close = () => { try { state.req.destroy(); } catch { /* already gone */ } state.closed = true; };
  return state;
}
// 连上还不够:要等服务端真的把这条连接登记进在场表(presence.ack 是登记之后写的第一帧)。
async function waitAck(stream) {
  await stream.ready;
  for (let i = 0; i < 200; i++) {
    if (stream.frames.some(f => f.event === 'presence.ack')) return true;
    await sleep(25);
  }
  return false;
}

// ── 假 provider:管家一句收;线程第一发直接提一个问题(注册 pending question = 「等你」) ──
async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const sys = messages.filter(m => m && m.role === 'system').map(m => String(m.content || '')).join('\n');
    const isSteward = /我是如意/.test(sys);
    const toolMsgs = messages.filter(m => m && m.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const sse = v => { try { res.write('data: ' + JSON.stringify(v) + '\n\n'); } catch { /* client gone */ } };
    const done = () => { try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* client gone */ } };

    if (isSteward) {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify({ say: '看过了。', why: '总览', acts: [], actions: [] }) }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      return done();
    }
    if (!toolMsgs.length) {
      const args = JSON.stringify({ questions: [{ header: '框架', question: '用哪个框架?', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: false }] });
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_q1', type: 'function', function: { name: 'request_user_input', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      return done();
    }
    sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '收工了,结论在这儿。' }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } });
    return done();
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}

// 每条线程给它自己的工作目录:仲裁器对【同 cwd】的线程加写锁串行(13n),共用一个 cwd 时
// 第二条线程会一直排队 —— 本件要的是【同时挂着待决的几条线程】,串行就测不出四种在场情形。
function threadCwd(home, name) {
  const dir = path.join(home, 'ws-' + name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
async function newThread(port, token, title, cwd) {
  const res = await request(port, 'POST', '/api/steward/act', {
    act: { kind: 'tool', tool: 'steward_thread_new', args: { title, cwd, brief: { userText: '把这件事推进到底', goal: '给一句结论' } } },
  }, token);
  return (res && res.json && res.json.result && res.json.result.sessionId) || '';
}
async function inboxRows(port, token) {
  const res = await request(port, 'GET', '/api/steward/inbox?limit=200', null, token);
  return (res && res.json && Array.isArray(res.json.items)) ? res.json.items : [];
}
// 这条线程此刻的待决(用它当「事件已经发生」的证据 —— 待决一挂上,下一拍收件箱就会看见它)。
// 读的是投影自己的待决面 GET /api/interventions/:sessionId —— 与收件箱第三源同一份数组,
// 拿别的面当证据就可能出现「我看到了、轮询器还没看到」的假红。
async function pendingOf(port, token, sessionId) {
  const res = await request(port, 'GET', `/api/interventions/${sessionId}?limit=50`, null, token);
  const list = (res && res.json && Array.isArray(res.json.interventions)) ? res.json.interventions : [];
  return list.filter(iv => iv && iv.status === 'pending');
}
async function waitPending(port, token, sessionId, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    if ((await pendingOf(port, token, sessionId)).length >= 1) return true;
    await sleep(200);
  }
  return false;
}
async function missionRow(port, token, sessionId) {
  const res = await request(port, 'GET', '/api/missions?limit=200', null, token);
  const rows = (res && res.json && Array.isArray(res.json.missions)) ? res.json.missions : [];
  return rows.find(row => row && row.sessionId === sessionId) || null;
}

const appPort = await getFreePort();
const providerPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-presence-gate-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);
// 五条线程各自的工作目录。必须【先建好、并登记进 workspaces[]】—— steward_thread_new 的 cwd 只认
// 表里那几行(13k stewardCwdCheck,cwd_not_in_workspaces),不在表里的目录连线程都开不出来。
const WS_NAMES = ['x', 'x2', 'y', 'z', 'w'];
for (const name of WS_NAMES) fs.mkdirSync(path.join(home, 'ws-' + name), { recursive: true });
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  configSchema: 9,
  version: '2.4.0',
  activeProvider: 'fake',
  engineMode: 'interactive',
  permissionMode: 'default',
  theme: 'dark',
  uiMode: 'pro',
  locale: 'zh-CN',
  defaultWorkspace: home,
  workspaces: [{ path: home, read: true, write: true, execute: true },
    ...WS_NAMES.map(name => ({ path: path.join(home, 'ws-' + name), read: true, write: true, execute: true }))],
  includeWorkbenchMcp: false,
  killOnDisconnect: false,
  subagentMaxPerTurn: 0,
  stewardEnabledV1: true,
  stewardPollMs: POLL_MS,
  stewardVisitIdleMinutes: 60,
  stewardProviderId: 'fake',
  stewardModel: 'fake-model',
  stewardThreadBriefV1: false,
  stewardMaxTurnsPerHour: 500,
  stewardGlobalMaxTurnsPerHour: 2000,
  stewardMaxParallelThreads: 8,   // 四条线程要同时挂着待决(仲裁器默认并发位不够)
  providers: [{
    id: 'fake', label: 'Fake', type: 'openai-compat',
    baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model',
    models: [{ id: 'fake-model', label: 'Fake' }],
  }],
}), 'utf8');

let provider = null;
let server = null;
let seat = null;
try {
  provider = await startProvider(providerPort);
  server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
    windowsHide: true, stdio: 'ignore',
  });
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', r => r.status === 200, undefined, 300)), 'A0 workbench started');
  let token = '';
  for (let i = 0; i < 80 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A0b runtime token 可读');

  /* ═════════ P1 坐在 X 上 -> X 的 needs_you 不进箱 ═════════ */
  // 先把在场建起来【再】起线程:门是在收件箱那一拍读在场的,顺序反了就测不到。
  // sessionId 此刻还不知道(线程还没开),所以先连一条 lens=classic 的空座,等拿到 X 再换座。
  const X = await newThread(appPort, token, '我正坐着的那条线程', threadCwd(home, 'x'));
  ok(Boolean(X), `P0 开出线程 X(${X || '失败'})`);
  if (!X) throw new Error('thread fixture unavailable');
  seat = openPresence(appPort, token, 'classic', X);
  ok(await waitAck(seat), 'P0b 在场连接建好(lens=classic,坐在 X 上)');

  ok(await waitPending(appPort, token, X), 'P1a 线程 X 真的挂上了一条待决(question)');
  await sleep(TICK_WAIT);
  let rows = await inboxRows(appPort, token);
  ok(!rows.some(r => r && r.sessionId === X && r.kind === 'needs_you'),
    `P1b 【在场门】用户就坐在 X 上,X 的 needs_you 不生成收件箱行(实得 ${rows.filter(r => r && r.sessionId === X).map(r => r.kind).join(',') || '零行'})`);
  // 索引仍然照常有它 —— 门挡的是【打扰】,不是【可见】。
  const seatedRow = await missionRow(appPort, token, X);
  ok(Boolean(seatedRow), 'P1c 同一时刻 X 仍然在 /api/missions 里(门挡打扰,不挡可见)');
  ok(Boolean(seatedRow && seatedRow.seatedBy === 'user'),
    `S1 索引行上 seatedBy==='user'(实得 ${JSON.stringify(seatedRow && seatedRow.seatedBy)})`);

  /* ═════════ T 工具门:管家对 X 一律 seated_by_user ═════════ */
  const relay = await request(appPort, 'POST', '/api/steward/act', {
    act: { kind: 'tool', tool: 'steward_thread_continue', args: { sessionId: X, message: '继续' } },
  }, token);
  const relayResult = relay && relay.json && relay.json.result;
  ok(Boolean(relayResult && relayResult.ok === false && relayResult.error === 'seated_by_user'),
    `T1 steward_thread_continue 对 X 返回 seated_by_user(实得 ${JSON.stringify(relayResult && relayResult.error)})`);
  ok(Boolean(relayResult && relayResult.reason === 'seated_by_user' && relayResult.sessionId === X),
    'T1b 拒绝信封是结构化的(带 reason 与 sessionId,行动流水事后分得清)');
  ok(Boolean(relayResult && /你正在这条线程里/.test(String(relayResult.message || ''))),
    `T1c 拒绝理由是人话(实得 ${JSON.stringify(relayResult && relayResult.message)})`);
  const perm = await request(appPort, 'POST', '/api/steward/act', {
    act: { kind: 'tool', tool: 'steward_thread_permission', args: { sessionId: X, permissionMode: 'plan' } },
  }, token);
  ok(Boolean(perm && perm.json && perm.json.result && perm.json.result.error === 'seated_by_user'),
    `T2 steward_thread_permission 对 X 返回 seated_by_user(实得 ${JSON.stringify(perm && perm.json && perm.json.result && perm.json.result.error)})`);
  // 代答路径:steward_decide 拿 X 上那条真待决去答。
  const pendingIv = (await pendingOf(appPort, token, X))[0] || null;
  ok(Boolean(pendingIv && pendingIv.id), `T3a X 上取到那条待决(${pendingIv && pendingIv.id})`);
  const decided = await request(appPort, 'POST', '/api/steward/act', {
    act: { kind: 'tool', tool: 'steward_decide', args: { missionId: X, interventionId: pendingIv && pendingIv.id, action: 'answer', answer: 'React' } },
  }, token);
  ok(Boolean(decided && decided.json && decided.json.result && decided.json.result.error === 'seated_by_user'),
    `T3 代答路径 steward_decide 对 X 返回 seated_by_user(实得 ${JSON.stringify(decided && decided.json && decided.json.result && decided.json.result.error)})`);
  // 读【不】过门:用户问「那条在干嘛」时管家还得答得上来(§4.5 明说可以读)。
  // 这一条只能静态钉:`/api/steward/act` 的白名单(STEWARD_ACTION_HOOKS)只收【写】工具,
  // 读类工具根本走不到那条路由上,拿它来跑一次「没被拒」是假绿(它压根没被执行)。
  {
    const readSrc = readServerSource();
    const at = readSrc.indexOf('async function stewardImplThreadRead(');
    const end = readSrc.indexOf('\nasync function ', at + 10);
    const body = at >= 0 && end > at ? readSrc.slice(at, end) : '';
    ok(Boolean(body) && !/stewardSeated/.test(body),
      'T4 steward_thread_read 的函数体里【没有】这道门(§4.5「可以读」;拿 /api/steward/act 跑一次是假绿——读类工具根本不在它的白名单里)');
  }

  /* ═════════ 反向验证:拔掉在场(断连)-> 同一次调用不再被拒 ═════════ */
  seat.close();
  seat = null;
  // 13r 按连接生死记在场,close 之后服务端要收到 FIN 才把它从表里摘掉。
  for (let i = 0; i < 80; i++) {
    const row = await missionRow(appPort, token, X);
    if (row && row.seatedBy === null) break;
    await sleep(100);
  }
  const leftRow = await missionRow(appPort, token, X);
  ok(Boolean(leftRow && leftRow.seatedBy === null),
    `S2 断连之后 seatedBy 回到 null(实得 ${JSON.stringify(leftRow && leftRow.seatedBy)})`);
  const relayAgain = await request(appPort, 'POST', '/api/steward/act', {
    act: { kind: 'tool', tool: 'steward_thread_permission', args: { sessionId: X, permissionMode: 'plan' } },
  }, token);
  ok(Boolean(relayAgain && relayAgain.json && relayAgain.json.result && relayAgain.json.result.error !== 'seated_by_user'),
    `T5 【反向验证】人一走,同一次 steward_thread_permission 不再被这道门拒(实得 ${JSON.stringify(relayAgain && relayAgain.json && relayAgain.json.result && relayAgain.json.result.error)})`);

  /* ═════════ P2 坐在 Y 上 -> 别的线程的 needs_you 进箱且带 quiet:true ═════════ */
  // 用一条【新】线程 X2 而不是复用 X:待决的去重游标(13i cursor.pendingIds)在 P1 那一拍已经
  // 越过了 X 的那条待决 —— 被门挡下【不】等于没被看见,同一条待决此后不会再被产出一次。
  // 这正是 §4.3 ① 支的语义(「只更新索引与徽标」),拿它来测 ② 支会永远红,而那是夹具的错不是产品的错。
  const Y = await newThread(appPort, token, '我坐在的另一条线程', threadCwd(home, 'y'));
  ok(Boolean(Y), `P2a 开出线程 Y(${Y || '失败'})`);
  seat = openPresence(appPort, token, 'classic', Y);
  ok(await waitAck(seat), 'P2b 换座:在场连接改坐在 Y 上');
  ok(await waitPending(appPort, token, Y), 'P2c 线程 Y 挂上了一条待决(他正坐着的那条)');
  const X2 = await newThread(appPort, token, '他没在看的那条线程', threadCwd(home, 'x2'));
  ok(Boolean(X2), `P2c2 开出线程 X2(${X2 || '失败'})`);
  ok(await waitPending(appPort, token, X2), 'P2c3 线程 X2 也挂上了一条待决');
  await sleep(TICK_WAIT);
  rows = await inboxRows(appPort, token);
  const xQuiet = rows.find(r => r && r.sessionId === X2 && r.kind === 'needs_you') || null;
  ok(Boolean(xQuiet), 'P2d 坐在 Y 上时,别的线程(X2)的 needs_you 进了收件箱');
  ok(Boolean(xQuiet && xQuiet.payload && xQuiet.payload.quiet === true),
    `P2e 它带着 quiet:true(前端安静卡读这一格;实得 ${JSON.stringify(xQuiet && xQuiet.payload && xQuiet.payload.quiet)})`);
  ok(!rows.some(r => r && r.sessionId === Y && r.kind === 'needs_you'),
    'P2f 同一拍里,他正坐着的 Y 自己的 needs_you 仍然不进箱(①②两支同时成立)');
  seat.close(); seat = null;
  await sleep(500);

  /* ═════════ P3 在管家视角 -> 今天的行为(进箱、不打 quiet) ═════════ */
  seat = openPresence(appPort, token, 'steward', '');
  ok(await waitAck(seat), 'P3b 在场连接改成 lens=steward');
  const Z = await newThread(appPort, token, '管家视角下的线程', threadCwd(home, 'z'));
  ok(Boolean(Z), `P3a 开出线程 Z(${Z || '失败'})`);
  ok(await waitPending(appPort, token, Z), 'P3c 线程 Z 挂上了一条待决');
  await sleep(TICK_WAIT);
  rows = await inboxRows(appPort, token);
  const zRow = rows.find(r => r && r.sessionId === Z && r.kind === 'needs_you') || null;
  ok(Boolean(zRow), 'P3d 用户在管家视角:needs_you 照常进箱(今天的行为)');
  ok(Boolean(zRow && !(zRow.payload && zRow.payload.quiet)),
    `P3e 并且【不】打 quiet(安静卡是工作台那一面的东西;实得 ${JSON.stringify(zRow && zRow.payload && zRow.payload.quiet)})`);
  seat.close(); seat = null;
  await sleep(500);

  /* ═════════ P4 没有连接 -> 今天的行为(累积) ═════════ */
  const W = await newThread(appPort, token, '没人在的时候开的线程', threadCwd(home, 'w'));
  ok(Boolean(W), `P4a 开出线程 W(${W || '失败'})`);
  ok(await waitPending(appPort, token, W), 'P4b 线程 W 挂上了一条待决');
  await sleep(TICK_WAIT);
  rows = await inboxRows(appPort, token);
  const wRow = rows.find(r => r && r.sessionId === W && r.kind === 'needs_you') || null;
  ok(Boolean(wRow), 'P4c 没有任何在场连接:needs_you 照常累积进箱(今天的行为)');
  ok(Boolean(wRow && !(wRow.payload && wRow.payload.quiet)), 'P4d 并且不打 quiet');
  const wMission = await missionRow(appPort, token, W);
  ok(Boolean(wMission && wMission.seatedBy === null), 'P4e 无连接时索引行的 seatedBy 是 null');

  /* ═════════ 静态锁 ═════════ */
  const src = readServerSource();
  ok(/function stewardApplyPresenceGate\(events\)/.test(src), 'S3 在场门单点在编译产物里(13i)');
  ok(/function stewardSeatedByUser\(sessionId\)/.test(src), 'S4 工具门的在场判据单点在编译产物里(13k)');
  ok(/EventStreamHooks\.presenceSnapshot/.test(src) && !/13r[^\n]*stewardPresenceSnapshot\(\)[^\n]*13i/.test(src),
    'S5 三个消费面都经 EventStreamHooks 延迟绑定取在场(不直引 13r 的符号 = 零前向边)');
  ok((src.match(/typeof EventStreamHooks\.presenceSnapshot === 'function'/g) || []).length >= 4,
    'S6 四个消费面各自带 typeof 守卫(钩子未填充时 fail-open,不反噬)');
} finally {
  try { if (seat) seat.close(); } catch { /* ignore */ }
  killTree(server);
  try { if (provider) provider.close(); } catch { /* ignore */ }
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\nSTEWARD PRESENCE GATE E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });

// ────────────────────────────────────────────────────────────────────────────
// REVERSE VERIFICATION(32 号文 §4 纪律 5)
//   1. P1b:把 13i stewardTickOnce 里的 `const gated = stewardApplyPresenceGate(events);`
//      改成 `const gated = events;` -> P1b 必须 FAIL(门拔了,坐着也照样被戳)。
//   2. P2e:把 stewardApplyPresenceGate 里 `quiet: true` 改成 `quiet: false` -> P2e 必须 FAIL。
//   3. P2d:把那一支的 `out.push({ ...evt, payload: ... })` 改成 `continue` -> P2d 必须 FAIL
//      (坐在别的线程上就把所有事件都吞了 = 把「安静」做成了「静默」)。
//   4. P3e:把 ③ 那一支(stewardPresent)删掉 -> P3e 必须 FAIL(管家视角下也打了 quiet)。
//   5. S1/S2:把 13e overlayMissionCard 里的 seatedBy 改成恒 null -> S1 必须 FAIL。
//   6. T1/T2/T3:分别把 13k 两处与 13l 一处的 `if (stewardSeatedByUser(...)) return ...` 删掉
//      -> 对应那条必须 FAIL。T5 是它们的天然反向面(人一走就不该再拒),不用改源码。
//   7. T4:给 steward_thread_read 也加上同一道门 -> T4 必须 FAIL(§4.5 明说读不过门)。
// 每改一次都要 `node ruyi-workbench/app/build.js` 再单跑本件;跑完照原样改回来。
// ────────────────────────────────────────────────────────────────────────────
