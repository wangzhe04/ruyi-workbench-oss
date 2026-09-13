#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）

// 第 122 波 L1a 真浏览器 E2E：**config 姗姗来迟那两秒里的现场保护**（36 号文 §2.1 判据③；Codex §9 J05）。
//
// 真人场景：双击图标、页面起来了，用户在头两秒里已经开始动手 —— 点顶栏分段钮挑视角、在输入框
// 打字。而 `GET /api/status`（config 的唯一到达口）这时候还在路上；它一到，boot 末尾
// provider-settings.js 的 `fillSettings()` 就调 steward-shell.js 的 `syncStewardShellAvailability()`，
// 后者在「没存过显式非管家偏好」时补一次 `applyShellMode('steward')`。这一下必须**不许**掀掉用户
// 刚做的事：视角要听最后一次显式选择的、草稿一个字不许丢、焦点不许被抢、对话区不许被滚走。
//
// 与号文规格的两处出入（32 号文 §4 纪律 1：派单稿的落点执行者有权证伪，理由写在这里）：
//   ① 号文写「拦 `*/api/config*` 延迟放行」。**本仓没有 GET /api/config** —— `/api/config` 只有
//      POST（route-inventory.md:42），config 是随 `GET /api/status` 一起下来的
//      （provider-settings.js:72 `state.config = state.status.config || {}`）。所以这里拦的是
//      `*/api/status*`；要延迟的那件事一个字没变。
//   ② 号文把「草稿／焦点／滚动位置」四条都放在延迟窗那一组。可 boot 的次序是
//      `refreshStatus()`（被我们扣住）→ `refreshSessions()` → `openSession()`，所以**延迟窗里
//      对话区还是空的**，`scrollTop` 恒 0，那一条在 A 组量不到东西（会是一条假绿）。于是拆成两组：
//        · A 组＝号文那个场景（真延迟 1500 ms，窗口里点分段钮四下＋打草稿）：钉视角／偏好／草稿／焦点；
//        · B 组＝把同一条竞态**确定性地**摆出来（见下），此时页面已满载、对话区有真内容，
//          四条判据（视角／草稿／焦点／滚动）一次量全。
//
// B 组为什么能确定性复现，而 A 组只能碰运气：竞态的形状是「排队中的写回调 vs 后到的同步写」。
// `applyShellMode` 真换视角时把写属性交给 `document.startViewTransition(write)`（异步落地），
// 同值再写走同步 `write()`。于是【同一拍里】先请求 steward、再请求 classic，就必然是
// 「steward 排队 → classic 同步落地 → steward 才落」—— 修前后者被前者盖掉。设置里的视角下拉
// （`#cfgShellMode` 的 onchange，shell-mode.js `bindShellModeControl`）是**无条件**调
// `applyShellMode` 的产品入口（顶栏分段钮那条路 app-frame.js `setLens` 有一句
// `if (next === currentMode()) return next;` 的同值早退，摆不出这个形状），所以 B 组走它。
//
// 判定行：`SHELL MODE LATE CONFIG BROWSER E2E: ALL PASS`。
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

const HOLD_MS = 1500;                 // /api/status 扣住多久（号文：1500 ms）
const SETTLE_MS = 2000;               // 放行之后再观察多久（号文：2 s）
const DRAFT = '这段草稿是在 config 还没到的那两秒里打的，一个字都不许丢：abc 123 —— 末尾还有标点。';
const SHELL_MODE_KEY = 'wcw.shellMode';   // shell-mode.js SHELL_MODE_STORAGE_KEY

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

// 确定性 provider：每一发都回一段够长的中文，攒够高度让 #messages 真的能滚（B 组要它）。
async function startProvider(port) {
  const LONG = '这是一段用来把对话区撑高的回答。'.repeat(40);
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = payload => res.write('data: ' + JSON.stringify(payload) + '\n\n');
    frame({ choices: [{ index: 0, delta: { role: 'assistant', content: LONG }, finish_reason: null }] });
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}

// CDP 客户端。与 quiet-card.browser.e2e.js 的那一份同源，**多一件事**：把没有 id 的报文（＝事件）
// 派给订阅者 —— 本件要吃 `Fetch.requestPaused`（号文 §2.1 判据③ 的拦截手法）。
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

async function waitForBlankTarget(debugPort) {
  for (let i = 0; i < 300; i++) {
    const result = await request(debugPort, 'GET', '/json/list');
    const targets = result && Array.isArray(result.json) ? result.json : [];
    const target = targets.find(item => item.type === 'page');
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

const READY = `(() => {
  if (!window.state || !window.state.status || !window.state.config || !window.state.config.configSchema) return null;
  if (!document.getElementById('messages') || !document.getElementById('cfgShellMode')) return null;
  return { ready: true };
})()`;

// 现场快照：视角、本机偏好、草稿、焦点、对话区滚动位置 —— 四条判据一次读全。
const SCENE = `(() => {
  const input = document.getElementById('promptInput');
  const messages = document.getElementById('messages');
  let stored = '';
  try { stored = localStorage.getItem(${JSON.stringify(SHELL_MODE_KEY)}) || ''; } catch { stored = ''; }
  return {
    mode: document.documentElement.getAttribute('data-shell-mode') || '',
    stored,
    draft: input ? input.value : null,
    active: (document.activeElement && document.activeElement.id) || '',
    scrollTop: messages ? messages.scrollTop : -1,
    scrollHeight: messages ? messages.scrollHeight : -1,
    clientHeight: messages ? messages.clientHeight : -1,
    select: (document.getElementById('cfgShellMode') || {}).value || '',
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-shell-late-'));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
for (const dir of [home, work]) fs.mkdirSync(dir, { recursive: true });
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
  stewardPollMs: 30000,
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

  const created = await request(appPort, 'POST', '/api/sessions', { title: '现场保护那条线程', cwd: work }, token);
  const sid = created && created.json && created.json.session && created.json.session.id;
  ok(Boolean(sid), `A0c 线程已建（${sid}）`);
  if (!sid) throw new Error('session fixture unavailable');
  // 攒四回合长回答：B 组要 #messages 真的能滚（scrollHeight > clientHeight）。
  for (let i = 0; i < 4; i++) {
    await request(appPort, 'POST', '/api/chat/stream', { sessionId: sid, message: `第 ${i + 1} 问`, cwd: work }, token, 120000);
  }
  // 会话正文在信封的 `session.messages` 里，条数在 `messageCount`（13d:329 那一行）。
  ok(Boolean(await waitForHttp(appPort, 'GET', `/api/sessions/${encodeURIComponent(sid)}`,
    result => (((result.json && result.json.session && result.json.session.messages) || []).length) >= 8, token)), 'A0d 四个回合都落盘了（对话区有真内容可滚）');

  const executable = findBrowserExecutable();
  ok(Boolean(executable), 'A0e Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  const profile = path.join(root, 'profile');
  // 【先开空白页再导航】：`/api/status` 是 boot 的第一发请求，要拦它就必须在页面加载之前
  // 把 Fetch 域打开 —— 直接把 appUrl 交给浏览器命令行的话，等我们连上 CDP 时它早发完了。
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1280,900',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForBlankTarget(debugPort);
  ok(Boolean(target), 'A0f browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  /* ═════════ A：config 姗姗来迟的那 1500 ms（36 号文 §2.1 判据③）═════════ */
  const held = { count: 0, firstAt: 0, releasedAt: 0 };
  cdp.on('Fetch.requestPaused', async params => {
    const requestId = params.requestId;
    const url = String((params.request && params.request.url) || '');
    if (url.indexOf('/api/status') < 0) { try { await cdp.send('Fetch.continueRequest', { requestId }); } catch { /* 已走 */ } return; }
    held.count += 1;
    if (held.count > 1) { try { await cdp.send('Fetch.continueRequest', { requestId }); } catch { /* 已走 */ } return; }
    held.firstAt = Date.now();
    setTimeout(async () => {
      held.releasedAt = Date.now();
      try { await cdp.send('Fetch.continueRequest', { requestId }); } catch { /* 已走 */ }
    }, HOLD_MS);
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/status*', requestStage: 'Request' }] });
  await cdp.send('Page.navigate', { url: appUrl });

  // 先等那一发 `/api/status` 真的到手被扣住 —— 这一步同时是「延迟窗已经开着」的判据，也是
  // 「分段钮已经绑上了」的判据：boot 的次序是 initToken → initI18n → **bindEvents()** → bootData
  // → refreshStatus()。`#lensSeg` 本身是 index.html 里的静态节点，页面一到就在 DOM 里（第一版
  // 拿它当判据，于是四下点击全落在还没绑 onclick 的按钮上，实测第一下读回的是预绘写下的 steward）。
  for (let i = 0; i < 200 && held.count === 0; i++) await sleep(25);
  ok(held.count >= 1 && held.releasedAt === 0, `A1 /api/status 已被扣住，延迟窗开着（拦到 ${held.count} 发、尚未放行）`);
  ok(Boolean(await waitForEval(cdp, `(() => document.querySelector('#lensSeg [data-lens="classic"]') ? 1 : null)()`, 300)),
    'A1b config 还没到，顶栏分段钮已经在屏幕上、也已经绑好（bindEvents 早于 bootData）');

  // 号文 ③ 的动作序列：分段钮 steward→classic→steward→classic。
  const clicks = [];
  for (const lens of ['steward', 'classic', 'steward', 'classic']) {
    clicks.push(await cdp.evaluate(`(() => {
      const button = document.querySelector('#lensSeg [data-lens="${lens}"]');
      if (!button) return null;
      button.click();
      return document.documentElement.getAttribute('data-shell-mode') || '';
    })()`));
    await sleep(120);
  }
  ok(clicks.every(value => value !== null), `A2 四下分段钮都点到了真按钮（每下点完的实况 ${JSON.stringify(clicks)}）`);
  // 打草稿：真键入（Input.insertText 走浏览器的输入通道，不是直接赋 value）。
  await cdp.evaluate(`(() => { const el = document.getElementById('promptInput'); if (el) el.focus(); return Boolean(el); })()`);
  await cdp.send('Input.insertText', { text: DRAFT });
  const typed = await cdp.evaluate(SCENE);
  ok(typed && typed.draft === DRAFT, `A3 草稿已经打进输入框（${typed && typed.draft ? typed.draft.length : 0} 字）`);
  ok(typed && typed.active === 'promptInput', `A3b 焦点在输入框上（实得 ${typed && typed.active}）`);
  ok(held.releasedAt === 0, 'A3c 到这里 /api/status 还扣着（上面这些动作确实发生在延迟窗里）');

  // 放行 → config 到达 → boot 走完 → syncStewardShellAvailability() 补判那一下也跑过了。
  ok(Boolean(await waitForEval(cdp, READY, 600)), 'A4 放行后首屏就绪（config 到了、boot 走完）');
  ok(held.releasedAt > 0 && (held.releasedAt - held.firstAt) >= HOLD_MS - 50,
    `A4b /api/status 真的被扣了 ${held.releasedAt - held.firstAt} ms（≥${HOLD_MS}）`);
  await cdp.send('Fetch.disable');
  await sleep(SETTLE_MS);
  const after = await cdp.evaluate(SCENE);
  ok(after.mode === 'classic',
    `A5 视角是最后一次显式选择（classic；实得 ${after.mode}）—— config 到达那一下没有把它翻掉`);
  ok(after.stored === 'classic',
    `A5b 本机偏好也是最后一次显式选择（classic；实得「${after.stored}」）`);
  ok(after.draft === DRAFT, `A6 草稿逐字相等（实得 ${after.draft === DRAFT ? '相等' : JSON.stringify(after.draft)}）`);
  ok(after.active === 'promptInput', `A7 焦点没被抢走（仍在 promptInput；实得 ${after.active}）`);

  /* ═════════ B：把「排队的写回调 vs 后到的同步写」摆成确定性的一拍 ═════════ */
  // 页面此刻满载：对话区有四个回合的真内容。先把现场做出来 —— 滚到中段、焦点在输入框、草稿在。
  ok(Boolean(await waitForEval(cdp, `(() => {
    const box = document.getElementById('messages');
    return box && box.scrollHeight - box.clientHeight > 200 ? 1 : null;
  })()`, 400)), 'B0 对话区真的能滚（scrollHeight − clientHeight > 200）');
  const scrolled = await cdp.evaluate(`(() => {
    const box = document.getElementById('messages');
    box.scrollTop = Math.floor((box.scrollHeight - box.clientHeight) / 2);
    const input = document.getElementById('promptInput');
    if (input) input.focus();
    return ${SCENE};
  })()`);
  ok(scrolled.scrollTop > 20, `B0b 对话区已滚到中段（scrollTop=${scrolled.scrollTop}）`);
  ok(scrolled.active === 'promptInput', `B0c 焦点在输入框（实得 ${scrolled.active}）`);
  // **基线要静置后再取**：刚打开一条会话的那几百毫秒里，中栏还在补渲染（第一版直接拿刚设进去的
  // 1217 当基线，2 s 后读到 2434 —— 那是补渲染把内容撑高之后的粘底，与本组要量的视角意图无关）。
  // 静置 SETTLE_MS 之后再读一次当基线，并顺手钉住「基线本身是稳的」，否则 B6 就不是在量乱序。
  await sleep(SETTLE_MS);
  const beforeB = await cdp.evaluate(SCENE);
  await sleep(800);
  const steady = await cdp.evaluate(SCENE);
  ok(Math.abs(steady.scrollTop - beforeB.scrollTop) <= 2,
    `B0d 静置下来的滚动位置本身是稳的（${beforeB.scrollTop} → ${steady.scrollTop}，差 ≤2 px；scrollHeight ${beforeB.scrollHeight}→${steady.scrollHeight}）—— B6 的前提`);

  // 同一拍里先请求 steward、再请求 classic。走设置里的视角下拉（`#cfgShellMode` 的 onchange）——
  // 它是无条件调 applyShellMode 的产品入口（顶栏分段钮那条路有同值早退，摆不出这个形状）。
  const race = await cdp.evaluate(`(() => {
    const sel = document.getElementById('cfgShellMode');
    if (!sel) return null;
    const read = () => document.documentElement.getAttribute('data-shell-mode') || '';
    const before = read();
    sel.value = 'steward'; sel.dispatchEvent(new Event('change'));
    const mid = read();
    sel.value = 'classic'; sel.dispatchEvent(new Event('change'));
    return { before, mid, after: read() };
  })()`);
  ok(Boolean(race), 'B1 设置里的视角下拉在屏幕上（本组的产品入口）');
  ok(race && race.before === 'classic', `B1b 起点是工作台视角（实得 ${race && race.before}）`);
  ok(race && race.mid === 'classic',
    `B2 第一次意图（steward）的写回调**确实被视图过渡推迟了** —— 派完 change 之后属性仍是 classic（实得 ${race && race.mid}）。这一条不成立的话本组量的就不是乱序，而是两次同步写`);
  ok(race && race.after === 'classic',
    `B2b 第二次意图（classic）走同步支、当场落地（实得 ${race && race.after}）`);

  await sleep(SETTLE_MS);
  const afterB = await cdp.evaluate(SCENE);
  ok(afterB.mode === 'classic',
    `B3 排队的 steward 写回调落地之后，视角仍是最后一次意图 classic（实得 ${afterB.mode}）—— 这就是 §2.1 的意图序号`);
  ok(afterB.stored === 'classic', `B3b 本机偏好仍是 classic（实得「${afterB.stored}」）`);
  ok(afterB.select === 'classic', `B3c 设置里的下拉也对到 classic（实得「${afterB.select}」）—— 作废的意图连控件都不许对`);
  ok(afterB.draft === DRAFT, `B4 草稿逐字相等（实得 ${afterB.draft === DRAFT ? '相等' : JSON.stringify(afterB.draft)}）`);
  ok(afterB.active === 'promptInput', `B5 焦点没被抢走（实得 ${afterB.active}）—— 作废的意图不许落焦到 stewardShell`);
  ok(Math.abs(afterB.scrollTop - steady.scrollTop) <= 2,
    `B6 对话区滚动位置纹丝不动（前 ${steady.scrollTop} → 后 ${afterB.scrollTop}，差 ≤2 px；scrollHeight ${steady.scrollHeight}→${afterB.scrollHeight}）`);
} catch (error) {
  fail += 1;
  console.log('FAIL 未预期异常: ' + (error && error.message ? error.message : String(error)));
} finally {
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  if (provider) { try { provider.close(); } catch { /* ignore */ } }
  try { stopRuyiTestBrowsers(path.join(root, 'profile')); } catch { /* ignore */ }
}

console.log(`\nSHELL MODE LATE CONFIG BROWSER E2E: ${fail ? 'FAIL (' + fail + ')' : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
})();
