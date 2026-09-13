#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）

// 第 122 波 L1a 真浏览器 E2E：**SSE 重连补发不许被当成新事**（36 号文 §2.3；Codex §9 J16）。
//
// K2b 的客户端（js/event-stream.js）断线重连时带 `Last-Event-ID`，13r 就把环里 id 更大的帧整段
// 重发一遍（13r:264 那三行）。补发是对的 —— 断线那几秒里真的发生过的事不能丢。可**断线之前
// 已经派发过的帧**如果也跟着回来一遍，前端就会把它们当新事再吃一次：
//   · 用户刚点掉的安静卡，凭空又冒出来第二张；
//   · 已经回答过的 needs_you，又被当成「等你」提醒一次。
// 修法在 dispatchFrame：按帧 id 去重（补发段里 `id <= lastSeenSeq` 丢弃）。为什么闸门只开在
// 「补发段」（本连接的 presence.ack 之前）而不是无条件 —— 见 event-stream.js dispatchFrame 的头注
// （13r 的 seq 随进程走，服务重启后从 1 重数；无条件水位会让活过一次重启的标签页永久失聪）。
//
// 手法（号文 §2.3）：用 CDP `Fetch` 把浏览器的**下一次** `/api/events/stream` 重连请求拦下来，
// 把它自己带的 `Last-Event-ID` 改写成更早的 id 再放行 —— 服务端于是重放一大段【客户端早就见过】
// 的帧。逼重连沿 `event-stream-client.browser.e2e.js` 的办法：换会话 ＝ 在场变 ＝ 重连
// （13r 的连接表是在场信号的唯一写口，见 event-stream.js 文件头注 ②）。
//
// 「服务端真的重放了」这件事本身也要有证据，否则两组都会因为「什么都没发生」而假绿：
// 本件另开一条**并行的 Node SSE 客户端**（与 event-stream-client.browser.e2e.js 同源的读法），
// 带同一个早 id 连一次，数它收到多少帧、里头有没有那条 `inbox.appended` —— 这就是 C0/E0。
//
// 判定行：`EVENT STREAM REPLAY BROWSER E2E: ALL PASS`。
(async () => {
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');
const { stopRuyiTestBrowsers } = require('./lib/browser-cleanup');
const { findBrowserExecutable } = require('./lib/browser-path');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CDP_COMMAND_TIMEOUT_MS = 90000;   // 单条 CDP 命令的看门狗（见 CdpClient.send 的注）
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const POLL_MS = 5000;        // 13i 收件箱 tick 的下限（安静卡吃的是那一拍派的 inbox.appended）
const WATCH_MS = 3000;       // 号文：重放之后观察 3 s

function request(port, method, pathname, body, token, timeoutMs = 30000) {
  return new Promise(resolve => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: timeoutMs,
      headers: {
        ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
        ...(token ? { 'x-wcw-token': token } : {}),
      },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* non-json */ } resolve({ status: response.statusCode, text, json }); });
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
    await sleep(80);
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

// 并行 Node SSE 客户端：**「服务端真的重放了」的唯一证据来源**（读法与
// event-stream-client.browser.e2e.js 逐字同源；不带 ?lens= 以免污染在场快照）。
function openStream(port, token, lastEventId) {
  const frames = [];
  const state = { frames, req: null, status: 0 };
  let buffer = '';
  state.ready = new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/events/stream', method: 'GET',
      headers: {
        ...(token ? { 'x-wcw-token': token } : {}),
        ...(lastEventId ? { 'last-event-id': String(lastEventId) } : {}),
      },
    }, response => {
      state.status = response.statusCode;
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        for (;;) {
          const cut = buffer.indexOf('\n\n');
          if (cut < 0) break;
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          let id = '';
          let event = '';
          const data = [];
          for (const line of block.split('\n')) {
            if (!line || line.startsWith(':')) continue;
            const colon = line.indexOf(':');
            const field = colon < 0 ? line : line.slice(0, colon);
            let value = colon < 0 ? '' : line.slice(colon + 1);
            if (value.startsWith(' ')) value = value.slice(1);
            if (field === 'id') id = value;
            else if (field === 'event') event = value;
            else if (field === 'data') data.push(value);
          }
          if (!event) continue;
          let payload = null;
          try { payload = JSON.parse(data.join('\n')); } catch { payload = null; }
          frames.push({ id, event, data: payload });
        }
      });
      resolve(state);
    });
    req.on('error', () => resolve(state));
    state.req = req;
    req.end();
  });
  return state;
}
function closeStream(state) { try { if (state && state.req) state.req.destroy(); } catch { /* ignore */ } }

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.socket = null; this.handlers = new Map(); }
  on(method, fn) { this.handlers.set(method, fn); }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
      this.socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (!message.id) {
          const handler = this.handlers.get(message.method);
          if (handler) { try { handler(message.params || {}); } catch { /* 事件回调出错不许掀翻连接 */ } }
          return;
        }
        if (!this.pending.has(message.id)) return;
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || 'cdp error'));
        else pending.resolve(message.result || {});
      });
      this.socket.addEventListener('close', () => {
        for (const pending of this.pending.values()) pending.reject(new Error('CDP socket closed'));
        this.pending.clear();
      });
    });
  }
  // 每条 CDP 命令都带自己的看门狗。理由是实测踩到的：本机无头 Edge 偶发**中途整个没了**
  // （PowerShell 数 msedge.exe 归零），而 socket 的 close 事件在那一刻不一定来 —— 没有这只狗的话
  // 一次 evaluate 会永远挂着，直跑时看上去像「卡在某条断言」，run-all 里则要白等满超时。
  send(method, params = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error('CDP 命令超时（' + timeoutMs + ' ms）：' + method + ' —— 浏览器多半已经没了'));
      }, timeoutMs);
      const settle = fn => value => { clearTimeout(timer); fn(value); };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate failed');
    }
    return result.result && result.result.value;
  }
  close() { try { this.socket && this.socket.close(); } catch { /* ignore */ } }
}

async function waitForTarget(debugPort, appUrl) {
  for (let i = 0; i < 200; i++) {
    const result = await request(debugPort, 'GET', '/json/list');
    const targets = result && Array.isArray(result.json) ? result.json : [];
    const target = targets.find(item => item.type === 'page' && String(item.url || '').startsWith(appUrl));
    if (target && target.webSocketDebuggerUrl) return target;
    await sleep(50);
  }
  return null;
}

async function waitForEval(cdp, expression, attempts = 800) {
  for (let i = 0; i < attempts; i++) {
    try {
      const value = await cdp.evaluate(expression);
      if (value) return value;
    } catch (error) {
      // 导航/reload 会换执行上下文（那种错要吞掉继续轮询）；但 CdpClient 的看门狗错说明浏览器
      // 已经没了 —— 那种要立刻抛出去，不然这里会拿 800 次 × 90 s 慢慢磨。
      if (String(error && error.message).indexOf('CDP') >= 0) throw error;
    }
    await sleep(40);
  }
  return null;
}

// 确定性 provider：'ask about X' → 单选 request_user_input；其余 → 一句短回答。
async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages[messages.length - 1] || {};
    const askMatch = last.role === 'user' ? String(last.content || '').match(/ask about (\w+)/) : null;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = payload => res.write('data: ' + JSON.stringify(payload) + '\n\n');
    if (askMatch) {
      const key = askMatch[1];
      const args = JSON.stringify({ questions: [{
        id: `q_${key}`, header: key, question: `${key} 那件事要等吗？`, answerMode: 'single',
        options: [{ id: 'wait', label: '等' }, { id: 'skip', label: '不等' }],
      }] });
      frame({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + key, type: 'function', function: { name: 'request_user_input', arguments: '' } }] }, finish_reason: null }] });
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '好的，记下了。' }, finish_reason: null }] });
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}

const READY = `(() => {
  if (!window.state || !window.state.status || !window.state.config || !window.state.config.configSchema) return null;
  if (!document.getElementById('railList') || !document.getElementById('quietCardHost')) return null;
  return { ready: true };
})()`;

const CARDS = `(() => {
  const host = document.getElementById('quietCardHost');
  const cards = host ? [...host.querySelectorAll('.quiet-card')] : [];
  return {
    mode: document.documentElement.getAttribute('data-shell-mode'),
    currentSessionId: (window.state && window.state.currentSession && window.state.currentSession.id) || '',
    count: cards.length,
    kinds: cards.map(node => node.dataset.kind + '@' + node.dataset.sessionId),
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-sse-replay-'));
const home = path.join(root, 'home');
const workSeated = path.join(root, 'work-seated');
const workOther = path.join(root, 'work-other');
const workThird = path.join(root, 'work-third');
for (const dir of [home, workSeated, workOther, workThird]) fs.mkdirSync(dir, { recursive: true });
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
  includeWorkbenchMcp: false,
  stewardEnabledV1: true,
  stewardPollMs: POLL_MS,
  stewardMaxParallelThreads: 5,
  stewardVisitIdleMinutes: 60,
  stewardConversationRetention: 'visit',
  providers: [{
    id: 'fake', label: 'Fake', type: 'openai-compat',
    baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model',
    models: [{ id: 'fake-model', label: 'Fake' }],
  }],
}), 'utf8');

let provider = null;
let server = null;
let browser = null;
let cdp = null;
let probe = null;
try {
  provider = await startProvider(providerPort);
  server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
    windowsHide: true, stdio: 'ignore',
  });
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200)), 'A0 workbench started');

  let token = '';
  for (let i = 0; i < 80 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A0b runtime token 可读');

  const created = {};
  for (const [key, title, cwd] of [
    ['seated', '坐着的那条', workSeated], ['other', '出事的那条', workOther], ['third', '换过去逼重连的那条', workThird],
  ]) {
    const response = await request(appPort, 'POST', '/api/sessions', { title, cwd }, token);
    created[key] = response && response.json && response.json.session && response.json.session.id;
    await request(appPort, 'PATCH', `/api/sessions/${encodeURIComponent(created[key])}`, { stewardWatch: true }, token);
  }
  ok(Object.values(created).every(Boolean), `A0c 三条线程已建（${JSON.stringify(created)}）`);
  if (!Object.values(created).every(Boolean)) throw new Error('session fixtures unavailable');

  const executable = findBrowserExecutable();
  ok(Boolean(executable), 'A0d Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  const profile = path.join(root, 'profile');
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1280,900',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A0e browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  ok(Boolean(await waitForEval(cdp, READY)), 'A0f 首屏就绪（config 到达、安静卡挂点已在 DOM 里）');

  // 静默时段（notify-policy 默认 22:00–08:00）会让安静卡整个不出（34 号文 §13.17）：先钉开。
  {
    const quietHour = (new Date().getHours() + 6) % 24;
    const pad = n => String(n).padStart(2, '0');
    await cdp.evaluate(`(() => { localStorage.setItem('wcw.notifyPolicy.v1', JSON.stringify({ version: 1, enabled: false, quietStart: '${pad(quietHour)}:00', quietEnd: '${pad(quietHour)}:01' })); return true; })()`);
  }

  const setLens = async lens => {
    for (let i = 0; i < 40; i++) {
      if (await cdp.evaluate(`(() => document.documentElement.getAttribute('data-shell-mode') === '${lens}')()`)) return 1;
      await cdp.evaluate(`(() => { const b = document.querySelector('#lensSeg [data-lens="${lens}"]'); if (b) b.click(); return Boolean(b); })()`);
      await sleep(80);
    }
    return null;
  };
  const openInWorkbench = async sessionId => {
    for (let i = 0; i < 8; i++) {
      await waitForEval(cdp, `(() => document.querySelector('#railList .steward-board-thread[data-session-id="${sessionId}"] .steward-board-thread-title') ? 1 : null)()`, 200);
      await cdp.evaluate(`(() => {
        const row = document.querySelector('#railList .steward-board-thread[data-session-id="${sessionId}"] .steward-board-thread-title');
        if (row) row.click();
        return Boolean(row);
      })()`);
      const matched = await waitForEval(cdp, `(() => (window.state && window.state.currentSession && window.state.currentSession.id === '${sessionId}') ? 1 : null)()`, 100);
      if (matched) return matched;
    }
    return null;
  };
  ok(Boolean(await setLens('classic')), 'A0g 工作台视角（安静卡只在这个视角出）');
  ok(Boolean(await openInWorkbench(created.seated)), 'A0h 已坐在「seated」那条线程上');

  /* ═════════ B：让「other」出事 → 安静卡出现 → 用户把它关掉 ═════════ */
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.other, message: 'ask about replay', cwd: workOther }, token, 600000);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return pending.some(item => item && item.type === 'question' && item.sessionId === created.other);
  }, token)), 'B0 「other」真的停在待决了（服务端事实）');
  ok(Boolean(await waitForEval(cdp, `(() => {
    const host = document.getElementById('quietCardHost');
    return host && host.querySelector('.quiet-card[data-session-id="${created.other}"]') ? 1 : null;
  })()`)), 'B1 安静卡出现了（这一张就是后面要被重放「再造一次」的那一帧）');
  // 用户按「稍后」把它关掉（quiet-card.js removeCard：卡从 cards 表里删干净，重放来了就会重建）。
  await cdp.evaluate(`(() => {
    const card = document.querySelector('#quietCardHost .quiet-card[data-session-id="${created.other}"]');
    const later = card && card.querySelector('.quiet-card-btn-later');
    if (later) later.click();
    return Boolean(later);
  })()`);
  const closed = await waitForEval(cdp, `(() => document.querySelectorAll('#quietCardHost .quiet-card').length === 0 ? 1 : null)()`, 200);
  ok(Boolean(closed), 'B2 用户把它关掉了，此刻零张卡');

  /* ═════════ C：服务端确实会重放 —— 并行 Node 客户端带早 id 连一次数给你看 ═════════ */
  probe = openStream(appPort, token, 1);
  await probe.ready;
  await sleep(1200);
  const replayFrames = probe.frames.slice();
  closeStream(probe);
  probe = null;
  const replayedInbox = replayFrames.filter(f => f.event === 'inbox.appended' && f.data && f.data.sessionId === created.other);
  ok(replayFrames.length >= 2,
    `C0 带 Last-Event-ID:1 连一次，服务端重放了 ${replayFrames.length} 帧（${JSON.stringify(replayFrames.map(f => f.id + ':' + f.event).slice(0, 12))}）—— 「重放真的会发生」的证据`);
  ok(replayedInbox.length >= 1,
    `C0b 重放里确实含「other」那条 inbox.appended（${replayedInbox.length} 条，id ${JSON.stringify(replayedInbox.map(f => f.id))}）—— 没有它，下面两组就是假绿`);

  /* ═════════ D：第一组 —— 关掉的安静卡不许被重放造出第二张 ═════════ */
  // 拦下浏览器的**下一次** `/api/events/stream`，把它自带的 Last-Event-ID 改写成 1 再放行。
  const intercepted = { count: 0, original: '', rewrittenTo: '' };
  cdp.on('Fetch.requestPaused', async params => {
    const requestId = params.requestId;
    const url = String((params.request && params.request.url) || '');
    const headers = (params.request && params.request.headers) || {};
    if (url.indexOf('/api/events/stream') < 0) { try { await cdp.send('Fetch.continueRequest', { requestId }); } catch { /* 已走 */ } return; }
    intercepted.count += 1;
    const rewritten = [];
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === 'last-event-id') { intercepted.original = String(value); continue; }
      rewritten.push({ name, value: String(value) });
    }
    intercepted.rewrittenTo = '1';
    rewritten.push({ name: 'last-event-id', value: '1' });
    try { await cdp.send('Fetch.continueRequest', { requestId, headers: rewritten }); } catch { /* 已走 */ }
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/events/stream*', requestStage: 'Request' }] });
  // 逼一次重连：换会话 ＝ 在场变 ＝ 重连（event-stream.js 文件头注 ②；沿 event-stream-client 的办法）。
  // 换到【第三条】而不是「other」—— 坐进 other 会让安静卡被在场门①挡掉，那样这一组就白测了。
  ok(Boolean(await openInWorkbench(created.third)), 'D0 换到第三条会话（在场变 → 300 ms 去抖后重连）');
  await sleep(WATCH_MS);
  ok(intercepted.count >= 1,
    `D1 那一次重连请求真的被拦到并改写了（拦到 ${intercepted.count} 发；原 Last-Event-ID「${intercepted.original}」→ 改成「${intercepted.rewrittenTo}」）`);
  const afterReplay = await cdp.evaluate(CARDS);
  ok(afterReplay.count === 0,
    `D2 重放之后 ${WATCH_MS} ms 内安静卡数量仍为 0（实得 ${afterReplay.count}：${JSON.stringify(afterReplay.kinds)}）—— 已经派发过的帧不许再造一张卡`);
  ok(afterReplay.currentSessionId === created.third && afterReplay.mode === 'classic',
    `D2b 现场也没被重放搅动（会话 ${afterReplay.currentSessionId}、视角 ${afterReplay.mode}）`);

  /* ═════════ E：第二组 —— 已回复的 needs_you 不许被重放复活 ═════════ */
  // 先把「other」那条待决真的回答掉（服务端事实：pending 里那条消失）。
  const pendingList = await request(appPort, 'GET', '/api/interventions?limit=100', null, token);
  const pendingItem = (((pendingList && pendingList.json && pendingList.json.pending) || [])
    .find(item => item && item.sessionId === created.other)) || null;
  ok(Boolean(pendingItem), 'E0a 找到「other」那条待决（准备回答它）');
  if (pendingItem) {
    await request(appPort, 'POST', '/api/chat/answer', {
      sessionId: created.other, questionId: pendingItem.id,
      answers: [{ questionId: 'q_replay', selectedOptionIds: ['skip'] }],
    }, token, 60000);
  }
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return !pending.some(item => item && item.sessionId === created.other);
  }, token)), 'E0 那条 needs_you 已经被回答掉了（服务端事实：pending 里不再有它）');
  // 把回答之后可能新出的卡（回合收尾／新一轮提问）先清干净，让 E2 的「0 张」只对重放负责。
  await cdp.evaluate(`(() => {
    for (const button of document.querySelectorAll('#quietCardHost .quiet-card .quiet-card-btn-later')) button.click();
    return true;
  })()`);
  await sleep(500);
  const cleared = await cdp.evaluate(CARDS);
  ok(cleared.count === 0, `E1 重放之前先清零（实得 ${cleared.count} 张：${JSON.stringify(cleared.kinds)}）`);

  const before = intercepted.count;
  ok(Boolean(await openInWorkbench(created.seated)), 'E1b 再换一次会话（第二次逼重连；同样会被拦下改写成早 id）');
  await sleep(WATCH_MS);
  ok(intercepted.count > before, `E2a 第二次重连也被拦到并改写了（累计 ${intercepted.count} 发）`);
  const afterSecond = await cdp.evaluate(CARDS);
  ok(afterSecond.count === 0,
    `E2 已回复的 needs_you 被重放回来也不复活：安静卡仍为 0（实得 ${afterSecond.count}：${JSON.stringify(afterSecond.kinds)}）`);
  const stillAnswered = await request(appPort, 'GET', '/api/interventions?limit=100', null, token);
  const stillPending = (((stillAnswered && stillAnswered.json && stillAnswered.json.pending) || [])
    .some(item => item && item.sessionId === created.other));
  ok(!stillPending, 'E2b 服务端那一侧也仍然是「已回复」（重放不改服务端事实，这一条排除「其实是又问了一遍」）');
  await cdp.send('Fetch.disable');
} catch (error) {
  fail += 1;
  console.log('FAIL 未预期异常: ' + (error && error.message ? error.message : String(error)));
} finally {
  if (probe) closeStream(probe);
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  if (provider) { try { provider.close(); } catch { /* ignore */ } }
  try { stopRuyiTestBrowsers(path.join(root, 'profile')); } catch { /* ignore */ }
}

console.log(`\nEVENT STREAM REPLAY BROWSER E2E: ${fail ? 'FAIL (' + fail + ')' : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
})();
