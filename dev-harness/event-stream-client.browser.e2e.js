#!/usr/bin/env node
'use strict';

// 真实浏览器 E2E(第 121 波 K2b · 34 号文 §6.2／§6.3／§6.4):事件流【客户端】。
//
// K2a 已经证明服务端那一头:五类事件各自从「事情发生」到「帧写出去」是 0–1 ms(event-stream.e2e.js)。
// 本件证明的是另一半 —— 屏幕。判据一律是【DOM 真的变了的那一刻】与【服务端写下那一帧的那一刻】
// 之差,两个时刻同机同钟:前者由页面里的 MutationObserver 在变化当拍记下(不靠外面轮询去问,
// 否则量到的是探询间隔而不是延迟),后者取自一条【并行的 Node SSE 客户端】收到的帧里的 `at`。
//
//   B §6.3 五指标 a–e 各 ≤1 s:
//     a 回合起跑 → 左栏那一行的药丸变「在跑」(li[data-state=running])
//     b 回合收工 → 药丸落到收尾档(done／stopped)
//     c 回合提问 → 药丸变「等你」(needs_you)
//     d 中途工具调用 → 焦点栏「它正在说 · 正在<工具>」那一行(**今天永远看不到的那一条**)
//     e 管家新开线程 → 左栏出现这一行
//     f 看板【收起】时左栏照样在 ≤1 s 内跟上 —— §6.2 删掉的那道「看板关着不刷」的门的正面证据
//   C 连接正常的 60 s 里 `/api/missions` 请求 ≤2(兜底节拍 30 s;推送不许换来一条请求风暴)
//   D 断连后兜底轮询【恢复今天的节奏】(≤35 s):工作台那张「它正在跑」卡的 3000 ms 表回来,
//     管家视角的 `/api/missions` 回到 config.stewardPollMs 那一档
//   E 换视角／换会话之后服务端的【在场快照】真的变了 —— 用 K3 的 `seatedBy` 作证
//     (13e:591 只在 `lens==='classic'` 且 sessionId 对上时才写 'user',所以它同时证明两个参数都报到了)
//
// 夹具:temp HOME ＋ 假 OpenAI 兼容 provider(同 event-stream.e2e.js 那一套)＋ Edge/Chrome 无头 CDP
// (同 live-full-text.browser.e2e.js 那一套)。config.stewardPollMs 刻意设成 8000 而不是拉满:
//   · 连接时 due=30 s ⇒ 60 s 窗口里只该有 2 拍(C 组);
//   · 断连时 due=8 s ⇒ 35 s 窗口里必有 ≥3 拍(D 组)。
// 拉满(120 s)的话 D 组恒真、形同虚设;设成 5 s 的话 C 组量不出连接与断连的差别。
// 判定行:`EVENT STREAM CLIENT BROWSER E2E: ALL PASS`。
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
const PUBLIC = path.join(WB, 'app', 'public');
const zh = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', 'zh-CN.json'), 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const THREAD_TITLE = '推送要照到的那条线程';
const SIDE_TITLE = '换会话用的另一条';
const SIDE2_TITLE = '逼重连用的第三条';
const LATENCY_BUDGET_MS = 1000;      // §6.3 的「≤1 s」
const QUIET_WINDOW_MS = 60000;       // C 组的观察窗（§6.3「连接正常 60 s 内 ≤2」）
const RECOVER_BUDGET_MS = 35000;     // D 组的恢复预算
const POLL_MS = 8000;                // config.stewardPollMs（断连时的「今天的节奏」那一档）
const LIVE_TICK_MS = 3000;           // session-experience.js 的 LIVE_TURN_POLL_MS
const STEWARD_TICK_MS = 5000;        // 管家三处轮询的【表周期】（STEWARD_POLL_MS_MIN；due 才是节拍）
const STREAM_MS = 2400;              // 第一发模型调用流多长时间的 delta（攒 thread.live）
const HANG_MS = 120000;              // 「HANGHERE」那一支把回合挂住多久（E/D 两组要它一直活着）
// 焦点栏「它正在说」那一行在带工具名时长什么样（键与参数都取自 locale，不在测试里写死中文）。
const USING_TOOL_TEXT = String(zh['stewardShell.drawer.usingTool'] || '').replace('{{tool}}', String(zh['stewardShell.drawer.tool.other'] || ''));

function request(port, method, pathname, body, token) {
  return new Promise(resolve => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: 30000,
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

// ── 并行 Node SSE 客户端:【服务端时刻】的唯一来源 ────────────────────────────────
// 与 event-stream.e2e.js 的读法逐字同源(不用 EventSource:这条路由是 token-browser 档)。
// 它只读不写,不带 ?lens= —— 于是它在 13r 的连接表里那一行 lens 是空串,不会污染 seatedBy(E 组的
// 判据要求 lens==='classic',见 13e:593)。
function openStream(port, token, query) {
  const frames = [];
  const state = { frames, closed: false, status: 0, req: null };
  let buffer = '';
  state.ready = new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/events/stream' + (query || ''), method: 'GET',
      headers: { ...(token ? { 'x-wcw-token': token } : {}) },
    }, response => {
      state.status = response.statusCode;
      response.setEncoding('utf8');
      response.on('data', chunk => {
        const at = Date.now();
        buffer += chunk;
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (!block.trim() || block.startsWith(':')) continue;
          const frame = { id: 0, event: '', data: null, at };
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) frame.id = Number(line.slice(4));
            else if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) { try { frame.data = JSON.parse(line.slice(6)); } catch { frame.data = null; } }
          }
          frames.push(frame);
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
async function waitForFrame(stream, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = stream.frames.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await sleep(25);
  }
}
// 服务端写下这一帧的时刻（13r 的 eventStreamPublish 把它写进载荷的 `at`）。
const serverAtOf = frame => Date.parse((frame && frame.data && frame.data.at) || '');

// ── fake provider ────────────────────────────────────────────────────────────
//   管家会话        → 结构化契约 JSON 一句收。
//   线程第 1 发     → 流 STREAM_MS 的 delta（攒 thread.live），静一下再要一次 file_read
//                     （静这一下是刻意的：thread.live 每会话 ≥500 ms 一条，不留空窗的话带工具名
//                     那一帧会被节流吞掉，指标 d 就量不到了）。
//   线程第 2 发     → request_user_input（注册 pending question ＝「等你」）。
//   线程第 3 发     → 一句话收工。
//   带 HANGHERE 的那一发 → 挂住 HANG_MS 持续吐字（E/D 两组要一个一直活着的回合）。
let probeFile = '';
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
    const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
    const userText = String((lastUser && lastUser.content) || '');
    const toolMsgs = messages.filter(m => m && m.role === 'tool').map(m => String(m.content || ''));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const sse = v => { try { res.write('data: ' + JSON.stringify(v) + '\n\n'); } catch { /* client gone */ } };
    const delta = text => sse({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
    const done = () => { try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* client gone */ } };

    if (isSteward) {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify({ say: '看过了。', why: '总览', acts: [], actions: [] }) }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      return done();
    }
    if (/HANGHERE/.test(userText)) {
      const rounds = Math.round(HANG_MS / 2500);
      for (let i = 0; i < rounds; i++) { delta(`挂着的第${i + 1}段：它还在一行行地往下说。`); await sleep(2500); }
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      return done();
    }
    if (!toolMsgs.length) {
      const ticks = Math.max(4, Math.round(STREAM_MS / 300));
      for (let i = 0; i < ticks; i++) {
        delta(`第${i + 1}段：我在看这件事。`);
        await sleep(300);
      }
      await sleep(900);   // 留一个 >500ms 的空窗，让带工具名那一帧过得了节流（指标 d 的前提）
      const args = JSON.stringify({ path: probeFile });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: { name: 'file_read', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      return done();
    }
    if (!toolMsgs.some(t => /Vue|React/.test(t))) {
      const args = JSON.stringify({ questions: [{ header: '框架', question: '用哪个框架?', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: false }] });
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_q1', type: 'function', function: { name: 'request_user_input', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      return done();
    }
    delta('收工了，结论在这儿。');
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } });
    return done();
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.socket = null; this.logs = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
      this.socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.method === 'Runtime.consoleAPICalled' || message.method === 'Runtime.exceptionThrown') {
          try { this.logs.push(JSON.stringify(message.params).slice(0, 400)); } catch { /* ignore */ }
          return;
        }
        if (!message.id || !this.pending.has(message.id)) return;
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result || {});
      });
      this.socket.addEventListener('close', () => {
        for (const pending of this.pending.values()) pending.reject(new Error('CDP socket closed'));
        this.pending.clear();
      });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime.evaluate failed';
      throw new Error(detail);
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
async function waitForEval(cdp, expression, attempts = 400) {
  for (let i = 0; i < attempts; i++) {
    try { const value = await cdp.evaluate(expression); if (value) return value; }
    catch { /* reload swaps execution context */ }
    await sleep(50);
  }
  return null;
}
// 等某一枚 DOM 时刻被记下（时刻本身是页面在变化【当拍】记的，这里只是把它取回来）。
async function waitForMark(cdp, key, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await cdp.evaluate(`window.__ruyiMarks ? (window.__ruyiMarks[${JSON.stringify(key)}] || 0) : 0`).catch(() => 0);
    if (value) return Number(value);
    if (Date.now() > deadline) return 0;
    await sleep(50);
  }
}

const READY = `(() => {
  if (!window.state || !window.state.config) return null;
  if (document.documentElement.getAttribute('data-shell-mode') !== 'steward') return null;
  if (!document.getElementById('stewardStatusLine')) return null;
  return { ready: true };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-event-stream-client-'));
const home = path.join(root, 'home');
const profile = path.join(root, 'profile');
fs.mkdirSync(home);
// 三条线程三个工作区：同一个 cwd 会被工作区写锁串起来，D 组那一发回合就会排在 B-f 起的那个
// 挂起回合后面（第一轮真踩过：D-0a 白等 30 s）。
const sideWork = path.join(root, 'work-side');
const side2Work = path.join(root, 'work-side2');
fs.mkdirSync(sideWork);
fs.mkdirSync(side2Work);
probeFile = path.join(home, 'probe.txt');
fs.writeFileSync(probeFile, '现场看过了。\n', 'utf8');
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  configSchema: 9, version: '2.4.0', activeProvider: 'fake', engineMode: 'interactive',
  permissionMode: 'default', theme: 'dark', uiMode: 'pro', locale: 'zh-CN',
  defaultWorkspace: home, includeWorkbenchMcp: false, killOnDisconnect: false,
  autoImportClaudeCodeMcp: false, subagentMaxPerTurn: 0,
  stewardEnabledV1: true,
  // 见文件头注：8000 这个数是 C 组与 D 组能互相证伪的那一档。
  stewardPollMs: POLL_MS,
  stewardVisitIdleMinutes: 60,
  stewardConversationRetention: 'visit',
  stewardProviderId: 'fake', stewardModel: 'fake-model', stewardThreadBriefV1: false,
  stewardMaxTurnsPerHour: 500, stewardGlobalMaxTurnsPerHour: 2000,
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
let stream = null;
try {
  provider = await startProvider(providerPort);
  server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
    windowsHide: true, stdio: 'ignore',
  });
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200, undefined, 300)), 'A1 workbench started');
  let token = '';
  for (let i = 0; i < 300 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A2 runtime token 可读');
  if (!token) throw new Error('token unavailable');

  stream = openStream(appPort, token, '');
  await stream.ready;
  ok(stream.status === 200, `A3 并行 Node SSE 客户端连上（服务端时刻的来源；实得 ${stream.status}）`);

  // 换会话用的第二条（D 组要靠「换会话」逼一次重连 —— 那是在场信号的唯一写口）。
  const side = await request(appPort, 'POST', '/api/sessions', { title: SIDE_TITLE, cwd: sideWork }, token);
  const sideId = side && side.json && side.json.session && side.json.session.id;
  const side2 = await request(appPort, 'POST', '/api/sessions', { title: SIDE2_TITLE, cwd: side2Work }, token);
  const side2Id = side2 && side2.json && side2.json.session && side2.json.session.id;
  // D 组靠在这两条之间换来回逼一次重连（在场信号的唯一写口）。
  ok(Boolean(sideId) && Boolean(side2Id), `A4 侧条里的两条会话已建（${sideId || '失败'} / ${side2Id || '失败'}）`);

  const executable = findBrowserExecutable();
  ok(Boolean(executable), 'A5 Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1440,1000',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A6 browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  // 页面侧的三件仪器。都在【预绘之前】装好：
  //   ① __ruyiMarks/__ruyiWatch：一枚 MutationObserver，在 DOM 真的变了的那一拍记时刻。
  //      判据写成字面量、参数走 __ruyiTargets（不用 new Function —— 页面 CSP 不给 unsafe-eval）；
  //      每枚时刻只记【第一次】成立，且必须先被 arm 过（否则「还没发生就已经成立」会记出一个假的早时刻）。
  //   ② __ruyiFetchLog：所有请求的 URL 与时刻（C/D 两组数 /api/missions 与 /api/sessions 的拍数）。
  //   ③ __ruyiLiveIntervals：活着的 setInterval 周期表（D 组要看 3000ms 那张表回来没有）。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__ruyiMarks = {};
      window.__ruyiTargets = { title: '', usingTool: ${JSON.stringify(USING_TOOL_TEXT)}, liveSay: ${JSON.stringify(String(zh['stewardShell.drawer.liveSay'] || ''))} };
      window.__ruyiArmed = {};
      window.__ruyiArm = key => { window.__ruyiArmed[key] = true; return true; };
      // 行的认定走【标题】而不是 sessionId：标题在线程建出来之前就知道，于是所有时刻都能在
      // 事情发生【之前】就 arm 好。拿 sessionId 做选择器的话得等接口返回才能填进来，
      // 而那一拍 DOM 往往已经变完了 —— 量到的就是「我们回头去问的时刻」，不是延迟。
      const row = () => {
        const title = window.__ruyiTargets.title;
        if (!title) return null;
        // 121-K4：行搬到左栏 #railList（看板浮层退役），类名与 data-state 一个字没变。
        const rows = [...document.querySelectorAll('#railList .steward-board-thread')];
        return rows.find(node => {
          const label = node.querySelector('.steward-board-thread-title');
          return label && String(label.textContent || '').indexOf(title) >= 0;
        }) || null;
      };
      const stateOf = () => { const node = row(); return node ? (node.getAttribute('data-state') || '') : ''; };
      const text = id => { const node = document.getElementById(id); return node ? String(node.textContent || '') : ''; };
      const checks = {
        e: () => Boolean(row()),
        a: () => stateOf() === 'running',
        c: () => stateOf() === 'needs_you',
        b: () => stateOf() === 'done' || stateOf() === 'stopped',
        d: () => text('stewardDrawerLastSayHead') === window.__ruyiTargets.liveSay
              && text('stewardDrawerLastSayText').indexOf(window.__ruyiTargets.usingTool) >= 0,
        f: () => stateOf() === 'running',
      };
      const tick = () => {
        for (const key of Object.keys(checks)) {
          if (!window.__ruyiArmed[key] || key in window.__ruyiMarks) continue;
          let hit = false;
          try { hit = Boolean(checks[key]()); } catch (e) { hit = false; }
          if (hit) window.__ruyiMarks[key] = Date.now();
        }
      };
      window.__ruyiTick = tick;
      const boot = () => {
        if (!document.documentElement) return;
        new MutationObserver(tick).observe(document.documentElement, {
          subtree: true, childList: true, characterData: true, attributes: true,
        });
      };
      if (document.documentElement) boot(); else document.addEventListener('readystatechange', boot, { once: true });

      const log = [];
      window.__ruyiFetchLog = () => log.slice();
      const nativeFetch = window.fetch;
      window.fetch = function (input, init) {
        let url = '';
        try { url = typeof input === 'string' ? input : String((input && input.url) || ''); } catch (e) { url = ''; }
        log.push({ url: url, at: Date.now() });
        return nativeFetch.call(window, input, init);
      };

      const live = new Map();
      const nativeSet = window.setInterval;
      const nativeClear = window.clearInterval;
      window.setInterval = function (handler, delay, ...rest) {
        const id = nativeSet.call(window, handler, delay, ...rest);
        live.set(id, Number(delay) || 0);
        return id;
      };
      window.clearInterval = function (id) { live.delete(id); return nativeClear.call(window, id); };
      window.__ruyiLiveIntervals = () => [...live.values()];
    })();`,
  });
  await cdp.send('Page.reload', { ignoreCache: true });
  ok(Boolean(await waitForEval(cdp, READY)), 'A7 首屏落管家视角（121-K0 的默认入口）且骨架就位');
  // 在场信号自报：页面发出去的那一发流请求带着 ?lens=steward。
  const streamReq = await waitForEval(cdp, `(() => {
    const hit = window.__ruyiFetchLog().filter(row => row.url.indexOf('/api/events/stream') >= 0);
    return hit.length ? hit[0].url : null;
  })()`);
  ok(Boolean(streamReq) && /[?&]lens=steward/.test(String(streamReq)) && /[?&]sessionId=/.test(String(streamReq)),
    `A8 页面用 fetch 读 SSE 且在连接参数里自报在场（§4.3；实得 ${streamReq}）`);
  const streamReqs0 = await cdp.evaluate(`window.__ruyiFetchLog().filter(row => row.url.indexOf('/api/events/stream') >= 0).map(row => row.url)`);
  // 一条连接的含义不是「一辈子只发一次请求」（换视角与换会话要重连，那是在场信号的唯一写口），
  // 而是「同一时刻只有一条在飞」。boot 末尾才 start（见 app.js 那段注），所以首屏就应该只有 1 条，
  // 且此后每一发的在场参数必须与上一发不同 —— 完全相同的两发 = 无缘无故多开了一条。
  ok(Array.isArray(streamReqs0) && streamReqs0.length === 1,
    `A8b 首屏只建【一条】连接（boot 末尾才 start，config 与首条会话都已落定；实测 ${JSON.stringify(streamReqs0)}）`);

  /* ═════════ C 连接正常的 60 s 里 /api/missions 请求 ≤2 ═════════ */
  // 刻意排在最前：此刻一条线程都没有、一帧 thread.* 都不会来，量到的就是【纯兜底节拍】。
  // 起算点取「已经发生过的最后一发 /api/missions」，免得把进壳那一次一次性刷新算进窗口。
  const missionsCountExpr = `window.__ruyiFetchLog().filter(row => row.url.indexOf('/api/missions') >= 0 && row.url.indexOf('/api/missions/') < 0).length`;
  const missionsAtExpr = `window.__ruyiFetchLog().filter(row => row.url.indexOf('/api/missions') >= 0 && row.url.indexOf('/api/missions/') < 0).map(row => row.at)`;
  // 起算点【对齐到刚发生过一拍之后】：表每 5 s 回来一次、due 是 30 s，不对齐的话第三拍会正好压在
  // 60 s 的边上（反向验证那一轮实测过一次 3 拍 —— 是相位边界，不是节拍变了）。对齐之后窗口取
  // 60 s 减 1.5 s 的余量，于是「30 s 一拍」这一档在窗口里最多 2 拍、「5 s／8 s」那两档必然 ≥7 拍。
  const seenBefore = (await cdp.evaluate(missionsAtExpr)) || [];
  await waitForEval(cdp, `${missionsCountExpr} > ${seenBefore.length} ? 1 : null`, 800);
  const quietStart = Date.now();
  await sleep(QUIET_WINDOW_MS - 1500);
  const seenAfter = (await cdp.evaluate(missionsAtExpr)) || [];
  const inWindow = (Array.isArray(seenAfter) ? seenAfter : []).filter(at => at >= quietStart);
  const quietPolls = inWindow.length;
  ok(quietPolls <= 2,
    `C1 连接正常的 ${Math.round((Date.now() - quietStart) / 1000)} s 里 /api/missions 只发了 ${quietPolls} 拍（≤2；兜底节拍 30 s，config.stewardPollMs=${POLL_MS} 那一档没有生效）`);
  // 为什么 ≤2 就已经把节拍钉紧了（而不需要再补一条「相邻间隔 ≥25 s」）：**一个兜底拍本来就要
  // 两发** —— 看板那一拍 refreshBoard 之后紧跟 syncNow，抽屉据此把焦点线程重读一遍，
  // 而它的 loadMissionSlice 是【经看板的 refreshRows】取行的（33 号文 §4 那条「抽屉的行不经
  // 本模块」的接线），于是同一拍里会出现相隔几百毫秒的两发 /api/missions。所以对齐后的
  // 58.5 s 窗口里「≤2 发」＝「最多一个兜底拍」：任何比 29 s 更快的节拍都会量到 ≥4 发。
  // （写这条时先补过一条 minGap ≥25 s 的伴随断言，实测 636 ms 真红 —— 红的不是节拍，是上面
  //   那一对；判据写错了就该拆掉，不该把它放宽成「≥500 ms」那种什么都拦不住的数。）
  const zeroLive = await cdp.evaluate(`window.__ruyiLiveIntervals().filter(ms => ms === ${LIVE_TICK_MS}).length`);
  ok(zeroLive === 0, `C2 连接正常时工作台那张「它正在跑」卡零 ${LIVE_TICK_MS}ms 表（实测 ${zeroLive} 张）`);

  /* ═════════ B §6.3 五指标 ═════════ */
  // 先 arm 再让事情发生 —— 顺序反了的话记下的是「等我们回头去问的时刻」，量的就不是延迟了。
  await cdp.evaluate(`(window.__ruyiTargets.title = ${JSON.stringify(THREAD_TITLE)}, window.__ruyiArm('e'), window.__ruyiArm('a'), window.__ruyiArm('c'), window.__ruyiArm('d'), true)`);
  const created = await request(appPort, 'POST', '/api/steward/act', {
    act: { kind: 'tool', tool: 'steward_thread_new', args: { title: THREAD_TITLE, cwd: home, brief: { userText: '把这件事推进到底', goal: '给一句结论' } } },
  }, token);
  const sid = created && created.json && created.json.result && created.json.result.sessionId;
  ok(Boolean(sid), `B0 管家开出线程（${sid || '失败'}）`);
  if (!sid) throw new Error('steward thread fixture unavailable');
  // 帧要按 sessionId 筛：开浏览器之前建的那两条会话也各派过一帧 thread.created，
  // 不筛的话拿到的是六十秒前那一帧，延迟就算成了一分钟（第一轮真踩过）。
  const createdFrame = await waitForFrame(stream, f => f.event === 'thread.created' && f.data && f.data.sessionId === sid);
  const eAt = await waitForMark(cdp, 'e', 20000);
  const eLag = eAt && createdFrame ? eAt - serverAtOf(createdFrame) : Infinity;
  ok(Boolean(eAt) && eLag <= LATENCY_BUDGET_MS,
    `B-e 指标 e：管家新开线程 → 左栏出现这一行 ${Number.isFinite(eLag) ? eLag : '∞'} ms ≤ ${LATENCY_BUDGET_MS}（今天是 ~30 s）`);

  const runningFrame = await waitForFrame(stream, f => f.event === 'thread.state' && f.data && f.data.sessionId === sid && f.data.state === 'running');
  const aAt = await waitForMark(cdp, 'a', 20000);
  const aLag = aAt && runningFrame ? aAt - serverAtOf(runningFrame) : Infinity;
  ok(Boolean(aAt) && aLag <= LATENCY_BUDGET_MS,
    `B-a 指标 a：回合起跑 → 左栏药丸变「在跑」${Number.isFinite(aLag) ? aLag : '∞'} ms ≤ ${LATENCY_BUDGET_MS}（今天是 ~15 s／∞）`);

  const toolFrame = await waitForFrame(stream, f => f.event === 'thread.live' && f.data && f.data.sessionId === sid && f.data.tool === 'file_read');
  ok(Boolean(toolFrame), `B-d0 服务端真的送出了带工具名的 thread.live（tool=${toolFrame && toolFrame.data.tool}）`);
  const dAt = await waitForMark(cdp, 'd', 20000);
  const dLag = dAt && toolFrame ? dAt - serverAtOf(toolFrame) : Infinity;
  ok(Boolean(dAt) && dLag <= LATENCY_BUDGET_MS,
    `B-d 指标 d：中途工具调用 → 焦点栏「它正在说 · 正在…」${Number.isFinite(dLag) ? dLag : '∞'} ms ≤ ${LATENCY_BUDGET_MS}（今天【永远看不到】）`);

  const needsFrame = await waitForFrame(stream, f => f.event === 'thread.needs_you' && f.data && f.data.sessionId === sid);
  const cAt = await waitForMark(cdp, 'c', 20000);
  const cLag = cAt && needsFrame ? cAt - serverAtOf(needsFrame) : Infinity;
  ok(Boolean(cAt) && cLag <= LATENCY_BUDGET_MS,
    `B-c 指标 c：回合提问 → 左栏药丸变「等你」${Number.isFinite(cLag) ? cLag : '∞'} ms ≤ ${LATENCY_BUDGET_MS}（今天是 5–15 s／∞）`);

  // b 只有等 c 落地之后才 arm：线程刚建出来那一瞬间也处在「非在跑」的档上，arm 早了会记下一个假时刻。
  await cdp.evaluate(`(window.__ruyiArm('b'), true)`);
  const interventions = await request(appPort, 'GET', '/api/interventions?limit=20', null, token);
  const pending = ((interventions && interventions.json && interventions.json.pending) || []).find(item => item && item.sessionId === sid);
  ok(Boolean(pending), `B-b0 待决就位（${pending && pending.id}）`);
  const donePromise = waitForFrame(stream, f => f.event === 'thread.done' && f.data && f.data.sessionId === sid);
  const answered = await request(appPort, 'POST', '/api/chat/answer', {
    sessionId: sid, questionId: pending && pending.id,
    answers: [{ question: '用哪个框架?', answer: ['Vue'] }], content: '用哪个框架?: Vue',
  }, token);
  ok(Boolean(answered && answered.status === 200), `B-b0b 回答落地（status ${answered && answered.status}）`);
  const doneFrame = await donePromise;
  const bAt = await waitForMark(cdp, 'b', 60000);
  const bLag = bAt && doneFrame ? bAt - serverAtOf(doneFrame) : Infinity;
  ok(Boolean(bAt) && bLag <= LATENCY_BUDGET_MS,
    `B-b 指标 b：回合收工 → 左栏药丸落到收尾档 ${Number.isFinite(bLag) ? bLag : '∞'} ms ≤ ${LATENCY_BUDGET_MS}（今天是 ~5 s）`);

  /* ═════════ B-f 左栏【常开】也照样跟得上（§6.2 删掉的那道门；121-K4 连门框一起拆了）═════════ */
  // K2b 时这一组的前提是「把看板收起来」——「看板关着不刷」那道门删掉之后，它仍是一个能立住的
  // 前提。121-K4 把浮层整块退役：左栏是常开的一栏，连「收起」这个状态都不存在了。
  // 所以 B-f0 翻面钉住那个前提本身已经消失，B-f 要证的事（推送到了左栏就跟得上）一个字没变。
  const collapsed = await waitForEval(cdp, `(!document.getElementById('stewardBoard') && document.querySelectorAll('#railList .steward-board-thread').length) ? 1 : null`);
  ok(Boolean(collapsed), 'B-f0 看板浮层已退役，左栏常开（「收起来还刷不刷」这个前提自此不存在）');
  await cdp.evaluate(`(window.__ruyiArm('f'), true)`);
  const hangRunning = waitForFrame(stream, f => f.event === 'thread.state' && f.data && f.data.sessionId === sid && f.data.state === 'running'
    && serverAtOf(f) > (doneFrame ? serverAtOf(doneFrame) : 0));
  request(appPort, 'POST', '/api/chat/stream', { sessionId: sid, message: 'HANGHERE 继续挂着', cwd: home }, token);
  const hangFrame = await hangRunning;
  const fAt = await waitForMark(cdp, 'f', 30000);
  const fLag = fAt && hangFrame ? fAt - serverAtOf(hangFrame) : Infinity;
  ok(Boolean(fAt) && fLag <= LATENCY_BUDGET_MS,
    `B-f 指标 f：看板收起时左栏那一行仍在 ${Number.isFinite(fLag) ? fLag : '∞'} ms 内变回「在跑」（≤${LATENCY_BUDGET_MS}；「看板关着不刷」那道门已删，32 号文 §5 的两笔债一并还）`);

  /* ═════ E 换视角／换会话 → 服务端在场快照真的变了 ═════ */
  // 判据是 K3 的 seatedBy（13e:591）：它只在【lens==='classic' 且 sessionId 对上】时才写 'user'，
  // 所以这一条同时证明「两个参数都报到了服务端」与「换视角／换会话真的重连了」。
  // 路径走产品自己那个入口：焦点栏的「在工作台打开」（#stewardDrawerClassicBtn → openClassicWindow，
  // 121-K5 起它的正身是 js/shell-mode.js 的 openInWorkbench：切视角 ＋ openSession，返回带已退役）
  // —— 切视角 ＋ 选中这条会话一步到位。（工作台侧条里找不到它：管家新开的线程不会把
  // 侧条刷一遍，那是 K4/K5 的活；本件不绕过它，直接走今天真存在的那个入口。）
  const rowSeated = async () => {
    const res = await request(appPort, 'GET', '/api/missions?limit=200', null, token);
    const row = ((res && res.json && res.json.missions) || []).find(item => item && item.sessionId === sid);
    if (!row) return 'missing';
    return (row.seatedBy === null || row.seatedBy === undefined) ? 'null' : String(row.seatedBy);
  };
  const seatedInSteward = await rowSeated();
  ok(seatedInSteward === 'null', `E1 管家视角里这一行没人坐着（seatedBy=null；实得 ${seatedInSteward}）`);
  const clickedClassic = await cdp.evaluate(`(() => {
    const button = document.getElementById('stewardDrawerClassicBtn');
    if (!button || button.hidden) return false;
    button.click();
    return true;
  })()`);
  ok(clickedClassic === true, 'E1b 焦点栏的「2.0 视窗」在屏幕上（右栅此刻开在这条线程上）');
  await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === 'classic' ? 1 : null`);
  await waitForEval(cdp, `(window.state && window.state.currentSession && window.state.currentSession.id === ${JSON.stringify(sid)}) ? 1 : null`);
  let seated = '';
  for (let i = 0; i < 80; i++) { seated = await rowSeated(); if (seated === 'user') break; await sleep(250); }
  ok(seated === 'user',
    `E2 换到工作台视角并坐进这条线程之后，服务端的在场快照变了（seatedBy=user；实得 ${seated}）—— 换视角／换会话的落实方式就是重连，服务端没有第二个写口`);
  const streamReqs = await cdp.evaluate(`window.__ruyiFetchLog().filter(row => row.url.indexOf('/api/events/stream') >= 0).map(row => row.url)`);
  const classicReq = (Array.isArray(streamReqs) ? streamReqs : []).find(url => /[?&]lens=classic/.test(String(url)) && String(url).indexOf(sid) >= 0);
  ok(Boolean(classicReq), `E3 那一次重连的连接参数确实换成了 lens=classic ＋ 这条 sessionId（实得 ${classicReq || JSON.stringify(streamReqs)}）`);
  const seq = (Array.isArray(streamReqs) ? streamReqs : []).map(String);
  ok(seq.length >= 2 && seq.every((url, i) => i === 0 || url !== seq[i - 1]),
    `E3b 每一发重连的在场参数都与上一发不同（重连只为在场变化而发，没有无缘无故多开；实测 ${JSON.stringify(seq)}）`);

  /* ═════ D 断连后兜底轮询恢复今天的节奏 ═════ */
  // 断连手法：CDP 挡掉 /api/events/stream（**只挡这一条路由** —— 别的请求照走。
  // 挡整个后端的话量到的是「服务没了」，而那种情形下兜底轮询也救不了谁，断言就没意义。
  // 挡完之后靠【换会话】逼一次重连（在场信号的唯一写口），新连接连不上 → connection=false
  // → 四处兜底各自回到今天的节奏。工作台那一半用侧条里真存在的两条会话做。
  request(appPort, 'POST', '/api/chat/stream', { sessionId: sideId, message: 'HANGHERE 挂着说', cwd: sideWork }, token);
  // 「有活回合」的判据取 `liveTail` 这个键在不在 —— 服务端只在真有活回合时才下发它，
  // 而 `resumable.live` 在 live 分支里【根本不回】（steward-drawer.js:665 那段注释写着同一件事，
  // 第一轮拿它做判据白等了 30 s）。
  ok(Boolean(await waitForHttp(appPort, 'GET', `/api/sessions/${encodeURIComponent(sideId)}`,
    result => Boolean(result.json && result.json.liveTail && typeof result.json.liveTail === 'object'), token, 300)),
    'D-0a 侧条里那条会话上起了一个【别处发起】的活回合（浏览器没挂在它的流上 —— 管家派活就是这个形状）');
  // 匹配【显示名或原话】两者之一：跑过回合的线程，行上显示的是 sessionDisplayTitle
  // （可能已被摘要换掉），原话只留在标题按钮的 title 属性里（116-5b「不改写 title」那条）。
  // 121-K4：点的是左栏那一行（两视角共用的同一份 DOM；工作台视角点它＝openSession）。
  const clickSession = title => cdp.evaluate(`(() => {
    const needle = ${JSON.stringify(title)};
    const items = [...document.querySelectorAll('#railList .steward-board-thread')];
    const hit = items.find(node => {
      const label = node.querySelector('.steward-board-thread-title');
      if (!label) return false;
      return String(label.textContent || '').indexOf(needle) >= 0 || String(label.title || '').indexOf(needle) >= 0;
    });
    if (hit) hit.querySelector('.steward-board-thread-title').click();
    return Boolean(hit);
  })()`);
  const diag = () => cdp.evaluate(`(() => ({
    mode: document.documentElement.getAttribute('data-shell-mode'),
    current: (window.state && window.state.currentSession && window.state.currentSession.id) || '',
    hasCard: Boolean(document.querySelector('#messages [data-live="1"]')),
    intervals: window.__ruyiLiveIntervals(),
    titles: [...document.querySelectorAll('#railList .steward-board-thread-title')].map(n => n.textContent + '|' + (n.title || '')),
  }))()`).catch(() => null);
  ok(await clickSession(SIDE_TITLE) === true, `D-0b 工作台侧条里点开那条会话（${SIDE_TITLE}）`);
  const liveCard = await waitForEval(cdp, `Boolean(document.querySelector('#messages [data-live="1"]')) ? 1 : null`);
  ok(Boolean(liveCard), 'D0 工作台里那张「它正在跑」卡在屏幕上');
  const beforeTimers = await cdp.evaluate(`window.__ruyiLiveIntervals().filter(ms => ms === ${LIVE_TICK_MS}).length`);
  ok(beforeTimers === 0, `D1 连着的时候它靠推送更新：零 ${LIVE_TICK_MS}ms 表（实测 ${beforeTimers}）`);
  await cdp.send('Network.setBlockedURLs', { urls: ['*/api/events/stream*'] });
  const cutAt = Date.now();
  const sessionsCountExpr = `window.__ruyiFetchLog().filter(row => row.url.indexOf('/api/sessions/') >= 0).length`;
  const sessionsBefore = await cdp.evaluate(sessionsCountExpr);
  const hopped = await clickSession(SIDE2_TITLE);   // 换会话 = 在场变 = 逼一次重连（而它已经被挡掉了）
  ok(hopped === true, 'D1b 换到另一条会话（这一步就是断连的扳机：在场信号变了 → 重连 → 新连接被挡）');
  await sleep(900);                                // 在场去拖 300 ms ＋ 那一发被挡掉的请求
  const backOn = await clickSession(SIDE_TITLE);    // 回到那条活回合上：断连了，它就该把 3 s 表开回来
  ok(backOn === true, 'D1c 再点回那条活回合的会话');
  const backTimer = await waitForEval(cdp, `window.__ruyiLiveIntervals().filter(ms => ms === ${LIVE_TICK_MS}).length === 1 ? 1 : null`, 600);
  const recoverMs = Date.now() - cutAt;
  ok(Boolean(backTimer) && recoverMs <= RECOVER_BUDGET_MS,
    `D2 断连后工作台那张卡的 ${LIVE_TICK_MS}ms 兜底表在 ${recoverMs} ms 内回来（≤${RECOVER_BUDGET_MS}）${backTimer ? '' : ' 实况=' + JSON.stringify(await diag())}`);
  await sleep(LIVE_TICK_MS + 800);
  const sessionsAfter = await cdp.evaluate(sessionsCountExpr);
  ok(sessionsAfter - sessionsBefore >= 2, `D2b 那张卡的取数也真的恢复了（/api/sessions/:id 多了 ${sessionsAfter - sessionsBefore} 发）`);
  // 管家侧：切回管家视角，/api/missions 必须回到 config.stewardPollMs 那一档 ——
  // 连着的时候 C 组量到的是「60 s 里 ≤2 拍」，断开之后同样长度的窗口里必须明显更密。
  await cdp.evaluate(`(() => { const sel = document.getElementById('cfgShellMode'); if (!sel) return false; sel.value = 'steward'; sel.dispatchEvent(new Event('change')); return true; })()`);
  ok(Boolean(await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === 'steward' ? 1 : null`)),
    'D3a 已切回管家视角（看板的兜底表只在这个视角里跑）');
  const missionsBefore = await cdp.evaluate(missionsCountExpr);
  const denseStart = Date.now();
  await sleep(RECOVER_BUDGET_MS);
  const missionsAfter = await cdp.evaluate(missionsCountExpr);
  const densePolls = missionsAfter - missionsBefore;
  ok(densePolls >= 3,
    `D3 断连后管家视角的 /api/missions 回到 config.stewardPollMs=${POLL_MS} 那一档：${Math.round((Date.now() - denseStart) / 1000)} s 里 ${densePolls} 拍（≥3；连着时同样长度的窗口只有 ${quietPolls} 拍）`);
  const timersNow = await cdp.evaluate(`window.__ruyiLiveIntervals()`);
  const stewardTables = (Array.isArray(timersNow) ? timersNow : []).filter(ms => ms === STEWARD_TICK_MS).length;
  ok(stewardTables >= 1 && stewardTables <= 3,
    `D4 兜底期间表仍然只有各模块自己那一处（壳层／看板／抽屉，最多 3 张 ${STEWARD_TICK_MS}ms 表；实测 ${JSON.stringify(timersNow)}）`);
} catch (error) {
  fail += 1;
  console.log('FAIL 夹具异常: ' + (error && error.message ? error.message : String(error)));
  if (cdp && cdp.logs.length) console.log('# 页面日志 tail: ' + cdp.logs.slice(-4).join(' | '));
} finally {
  try { stream && stream.close(); } catch { /* ignore */ }
  try { cdp && cdp.close(); } catch { /* ignore */ }
  killTree(browser);
  try { await stopRuyiTestBrowsers(profile); } catch { /* ignore */ }
  killTree(server);
  try { provider && provider.close(); } catch { /* ignore */ }
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(fail === 0 ? 'EVENT STREAM CLIENT BROWSER E2E: ALL PASS' : `EVENT STREAM CLIENT BROWSER E2E: FAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);

// ─────────────────────────────────────────────────────────────────────────────
// REVERSE VERIFICATION（下面每一条都【真跑过】一次：改动 → 记红 → 还原。日志留在
// scratchpad 的 rev-rba.log / rev-rba2.log / rev-rbb.log；静态那几把锁的红行同法记在
// steward-board.static F3/F3b、steward-walkthrough.static E1b/E3/E6/E8/E9/E10、
// steward-shell.static C2b2、steward-avatar.static D2 各自的注释里。）
//
// ① 第一轮（rev-rba.log）：把 steward-board.js 的
//      `for (const name of EVENT_STREAM_ROW_EVENTS) { stream.on(name, () => { void pushRefreshRows(); }); }`
//    与 steward-drawer.js 的 `stream.on(EVENT_STREAM_LIVE_EVENT, …)` 两处一起注释掉。
//    实测 4 红：B-e（∞）、B-a（∞）、B-d（∞）、B-c（25399 ms —— 被 30 s 那一拍兜底捞回来的）。
//    **B-b／B-f 仍绿**，这是本刀学到的一条结构事实，记在这里：抽屉的 `thread.*` 订阅经
//    `loadMissionSlice` 调 `source.refresh()`（＝看板的 `refreshRows`，33 号文 §4 那条
//    「抽屉的行不经本模块」的接线），于是左栏的行也被顺手刷了 —— 左栏吃推送有【两条】路。
//
// ② 第二轮（rev-rba2.log）：在 ① 之上再把 steward-drawer.js 的 `EVENT_STREAM_ROW_EVENTS`
//    那一圈也注释掉（两条路都断）。实测 7 红：B-e／B-a／B-d（∞）、B-c（25085 ms）、
//    **B-b（3652 ms）**、**B-f（29919 ms —— 正好一个 30 s 兜底拍）**，外加 C1（3 拍，见下）。
//    这一轮才是 B-b／B-f 的真反向面。
//
// ③ 第三轮（rev-rbb.log）：三处节拍与在场的判据各拔一处 ——
//      · steward-chips.js 的 `STEWARD_POLL_MS_CONNECTED` 30000 → 5000；
//      · session-experience.js 的 `if (liveStreamConnected) return false;` 删掉；
//      · event-stream.js 的 `sync()` 改成「在场变了也不重连」。
//    实测 5 红：C1（12 拍 > 2）、D1（连着时就有 1 张 3000 ms 表）、
//    E2（seatedBy 一直是 null）、E3／E3b（始终只有首屏那一发 lens=steward 的请求）。
//    D2 在这一轮【仍绿】，而且是【恒真地】绿：连接门一删，那张 3000 ms 表从头就开着
//    （D1 红说的就是这件事），D2 只问「它在不在」，于是这一轮证不了它。
//
// ④ 第四轮（rev-rbc.log）：D2 的真反向面 —— `liveTurnPollable` 第一句改成 `return false;`
//    （永不开表）。实测 D2 红（38300 ms，实况 intervals=[]，卡还在屏幕上），而 C2／D1
//    【仍绿】（零表）：C2/D1 与 D2 钉的本来就是相反的两件事（连着不开表 vs 断了要回来），
//    一改就两头都红的话说明其中一条是摆设。
//
// ⑤ C1 的相位边界（第二轮顺手逮到的，已修进本件）：起算点不对齐时，「30 s 一拍」在 60 s
//    窗口里会量到 3 拍（第三拍正好压在窗口边上）。修法是把起算点对齐到「刚发生过一拍」之后、
//    窗口取 60 s − 1.5 s —— 于是「≤2 发」＝「窗口里最多一个兜底拍」，任何比 29 s 更快的节拍
//    都会量到 ≥4 发（一个拍两发，理由写在 C1 上面）。
//    中途先补过一条「相邻两拍最小间隔 ≥25 s」的伴随断言，实测 636 ms 真红 —— 红的不是节拍，
//    是同一拍里那一对（看板 refreshBoard ＋ 抽屉 loadMissionSlice 经看板 refreshRows 取行）。
//    判据写错了就拆掉，没有放宽成「≥500 ms」那种什么都拦不住的数。
//
// ⑥ 静态那几把锁各自单独弄红过（命令见 scratchpad/rev.py 的八个用例，每个都是
//    「改一处 → 跑对应的 static 件 → 恰好 1 红 → 还原」）：
//      r1 `STEWARD_POLL_MS_CONNECTED` 30000→5000 → steward-board.static F3b 红、
//         steward-walkthrough.static E6 红；
//      r2 把 `isBoardOpen() && ` 加回 steward-board.js 的 syncPolling → steward-board.static F3 红；
//      r3 删掉 session-experience.js 的 `if (liveStreamConnected) return false;`
//         → steward-walkthrough.static E8 红；
//      r4／r5 抽屉／壳层的 due 各还原成 K2b 之前那一行 → E1b 红、C2b2＋E3 红；
//      r6 往 event-stream.js 多加一条 import → E10 红；
//      r7 把多行 `data:` 的拼接改成只取第一行 → E9 红；
//      r8 从壳层的 chips import 行里去掉 `STEWARD_POLL_MS_CONNECTED`
//         → steward-avatar.static D2（import 白名单）红。
// ─────────────────────────────────────────────────────────────────────────────
})();
