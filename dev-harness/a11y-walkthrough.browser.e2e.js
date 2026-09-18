#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离（见 lib 头注）

// 第 122 波 L1b · U05 走查（36 号文 §2.14，**验证型**）：200% 字体档的等效视口、纯键盘可达、
// 窄屏折叠。号文原话「只修走查抓到的；抓到零条也如实收口」—— 所以本件先是一台【量尺】，
// 抓到什么再改什么，改了什么写在交付报告里。
//
// 三组：
//   A 视口 640×480（≈1280×960 开 200% 字体的等效可视区，用 CDP Emulation.setDeviceMetricsOverride）：
//     ① 整页没有横向滚动（documentElement.scrollWidth ≤ clientWidth）；
//     ② 顶栏三枚全局控件（视角分段钮 #lensSeg ／ 盾牌 #stewardShieldBtn ／ 齿轮 #appGearBtn）的
//        getBoundingClientRect 完整落在视口里 —— 「看得见」不等于「在 DOM 里」。
//     两个视角各量一遍：顶栏是外框自己的一层，两视角共用同一份 DOM，但右栏／中栏的宽度不同。
//   B 纯键盘（默认 1280×900，工作台视角）：从 body 起连按 Tab，≤25 下要走到
//     ① 视角分段钮 ② #promptInput ③ 左栏第一行的标题按钮（.steward-board-thread-title ——
//     行本身【故意】不进 Tab 序，理由在 steward-board.js bindRowClick 的头注：行里嵌着好几枚
//     真按钮，给行套 role=button 是嵌套可交互元素）。
//     **这一组抓到了本次走查唯一的一条真问题**：①③ 分别是第 2、第 10 下，而 ② 要【31 下】——
//     对话区里每条消息的 .msg-actions（复制／编辑重发／重试／回溯／存为 playbook／存为记忆…）
//     每一枚都在 Tab 序里，于是这个数随对话长度无上限地长（本件夹具只有一个回合就已经 31）。
//     那批按钮不该退出 Tab 序（:focus-within 会把它们显出来，是真能用的键盘功能），所以修法是
//     标准的跳转链接 #skipToComposer（index.html 第一枚可聚焦元素）。判据因此改成：
//     第 1 下 Tab 必须落在它上面、且此刻真的看得见，Enter 之后焦点在【当前视角】的输入框里；
//     裸 Tab 距离仍然量出来打进 NOTE（它是那条产品债的体温计，不当判据）。
//   C 窄屏 800×900：
//     ① layout.css 那条 `@container frame (max-width: 980px)` 真的生效 —— 左栏折成 56px 图标栏
//        （--rail-w 的实测宽度，不是读 CSS 源码）；
//     ② 对话区宽度 ≥ 视口的 60%。
//
// 与 walkthrough-round2 同一套 CDP 无头驱动（含 90 s 单命令看门狗）。
// 判定行：`A11Y WALKTHROUGH BROWSER E2E: ALL PASS`。
(async () => {
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
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
const CDP_COMMAND_TIMEOUT_MS = 90000;
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const THREAD_TITLE = '窄屏那条线程';
const POLL_MS = 120000;
const TAB_BUDGET = 25;          // 号文 §2.14 ②
const NARROW_W = 640;           // 号文 §2.14 ①（≈200% 字体的等效可视区）
const NARROW_H = 480;
const MID_W = 800;              // 号文 §2.14 ③
const MID_H = 900;
const BASE_W = 1280;
const BASE_H = 900;

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
    await sleep(80);
  }
  return null;
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') killOwnTree(child);
    else child.kill('SIGKILL');
  } catch { /* already exited */ }
}

async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = payload => res.write('data: ' + JSON.stringify(payload) + '\n\n');
    frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '好。' }, finish_reason: null }] });
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.socket = null; }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
      this.socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (!message.id || !this.pending.has(message.id)) return;
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
  // 单命令看门狗（36 号文 §5.2 登记）：无头 Edge 偶发中途整个没了，没有这只狗 evaluate 会永远挂着。
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
      // 128c:socket 已关时 WebSocket.send() 按规范静默丢弃 —— 这个 Promise 就永远不 settle,测试挂到 run-all 超时、
      // 连一条 FAIL 都没有(F8 那批「只是超时」的偶发件就是这个形状:别的车道收尸杀了浏览器)。当场拒绝,带上方法名。
      if (!this.socket || this.socket.readyState !== 1) { const p = this.pending.get(id); this.pending.delete(id); (p ? p.reject : reject)(new Error('CDP socket not open (readyState=' + (this.socket ? this.socket.readyState : 'none') + '): ' + method)); return; }
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
  for (let i = 0; i < 300; i++) {
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
      if (String(error && error.message).indexOf('CDP') >= 0) throw error;
    }
    await sleep(40);
  }
  return null;
}

const READY = `(() => {
  if (!window.state || !window.state.status || !window.state.config || !window.state.config.configSchema) return null;
  if (!document.getElementById('railList') || !document.getElementById('appFrame')) return null;
  const button = document.querySelector('#lensSeg [data-lens]');
  if (!button || typeof button.onclick !== 'function') return null;
  return { ready: true };
})()`;

// A 组的量尺：整页横向溢出 ＋ 顶栏三枚控件是不是整个落在视口里。
const FIT_PROBE = `(() => {
  const root = document.documentElement;
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const box = selector => {
    const node = document.querySelector(selector);
    if (!node) return { selector, found: false };
    const b = node.getBoundingClientRect();
    return {
      selector, found: true,
      x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
      inside: b.width > 2 && b.height > 2 && b.left >= -1 && b.top >= -1 && b.right <= vw + 1 && b.bottom <= vh + 1,
    };
  };
  return {
    vw, vh,
    scrollWidth: root.scrollWidth,
    overflow: root.scrollWidth - vw,
    bodyOverflow: document.body.scrollWidth - vw,
    // 谁把页面撑宽了（把最靠右的那几个元素抓出来，抓到零条也如实收口）。
    widest: [...document.querySelectorAll('body *')]
      .map(node => ({ node, right: node.getBoundingClientRect().right }))
      .filter(row => row.right > vw + 1)
      .sort((a, b) => b.right - a.right)
      .slice(0, 5)
      .map(row => (row.node.id ? '#' + row.node.id : '') + '.' + String(row.node.className || row.node.tagName).split(' ')[0] + '@' + Math.round(row.right)),
    lens: box('#lensSeg'),
    shield: box('#stewardShieldBtn'),
    gear: box('#appGearBtn'),
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-a11y-walk-'));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
const profile = path.join(root, 'profile');
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
  stewardPollMs: POLL_MS,
  stewardVisitIdleMinutes: 60,
  onboarding: { completedAt: '2026-09-13T00:00:00.000Z', version: 1, skipped: false },
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

  const created = await request(appPort, 'POST', '/api/sessions', { title: THREAD_TITLE, cwd: work }, token);
  const sid = created && created.json && created.json.session && created.json.session.id;
  ok(Boolean(sid), `A0c 线程已建（${sid}）—— B 组要左栏真的有一行`);
  if (!sid) throw new Error('session fixture unavailable');
  await request(appPort, 'POST', '/api/chat/stream', { sessionId: sid, message: '一句', cwd: work }, token, 120000);

  const executable = findBrowserExecutable();
  ok(Boolean(executable), 'A0d Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', `--window-size=${BASE_W},${BASE_H}`,
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A0e browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  ok(Boolean(await waitForEval(cdp, READY)), 'A0f 首屏就绪');

  const resize = async (width, height) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(500);   // 容器查询重排 ＋ 视角容器的过渡
    return cdp.evaluate('({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight })');
  };
  const setLens = async lens => {
    await cdp.evaluate(`(document.querySelector('#lensSeg [data-lens="${lens}"]') || { click() {} }).click(), true`);
    return waitForEval(cdp, `(() => document.documentElement.getAttribute('data-shell-mode') === '${lens}'
      && !document.documentElement.dataset.vt ? 1 : null)()`);
  };

  /* ═════════ A 视口 640×480（≈200% 字体的等效可视区）═════════ */
  const metrics = await resize(NARROW_W, NARROW_H);
  ok(Boolean(metrics) && metrics.w === NARROW_W,
    `A1 视口已压到 ${NARROW_W}×${NARROW_H}（实测 ${metrics && metrics.w}×${metrics && metrics.h}）`);

  ok(Boolean(await setLens('steward')), 'A2a 管家视角');
  const stewardFit = await cdp.evaluate(FIT_PROBE);
  ok(stewardFit.overflow <= 1,
    `A2 管家视角 ${NARROW_W}px 下整页无横向滚动（scrollWidth ${stewardFit.scrollWidth} − clientWidth ${stewardFit.vw} = ${stewardFit.overflow}px；撑宽的：${JSON.stringify(stewardFit.widest)}）`);
  ok(stewardFit.lens.inside && stewardFit.shield.inside && stewardFit.gear.inside,
    `A3 管家视角：分段钮／盾牌／齿轮三枚都整个在视口里（${JSON.stringify([stewardFit.lens, stewardFit.shield, stewardFit.gear])}）`);

  ok(Boolean(await setLens('classic')), 'A4a 工作台视角');
  const classicFit = await cdp.evaluate(FIT_PROBE);
  ok(classicFit.overflow <= 1,
    `A4 工作台视角 ${NARROW_W}px 下整页无横向滚动（差 ${classicFit.overflow}px；撑宽的：${JSON.stringify(classicFit.widest)}）`);
  ok(classicFit.lens.inside && classicFit.shield.inside && classicFit.gear.inside,
    `A5 工作台视角：三枚全局控件都整个在视口里（${JSON.stringify([classicFit.lens, classicFit.shield, classicFit.gear])}）`);

  /* ═════════ B 纯键盘可达（默认 1280×900，工作台视角）═════════ */
  await resize(BASE_W, BASE_H);
  ok(Boolean(await waitForEval(cdp, `(() => document.querySelector('#railList .steward-board-thread-title') ? 1 : null)()`, 400)),
    'B0 左栏第一行在场');
  // 从 body 起：先把焦点摘干净（CDP 的 Tab 从 document.body 开始走 Tab 序）。
  await cdp.evaluate(`(() => { try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {} window.scrollTo(0, 0); return true; })()`);
  const stops = [];
  const want = { skip: -1, lens: -1, prompt: -1, rail: -1 };
  let skipShown = null;
  for (let i = 1; i <= 80; i++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
    const at = await cdp.evaluate(`(() => {
      const node = document.activeElement;
      if (!node || node === document.body) return { tag: 'BODY', id: '', cls: '', lens: false, rail: false };
      const b = node.getBoundingClientRect();
      const root = document.documentElement;
      return {
        tag: node.tagName,
        id: node.id || '',
        cls: String(node.className || ''),
        lens: Boolean(node.closest && node.closest('#lensSeg')),
        rail: Boolean(node.classList && node.classList.contains('steward-board-thread-title')),
        rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
        inside: b.width > 2 && b.height > 2 && b.left >= -1 && b.top >= -1 && b.right <= root.clientWidth + 1 && b.bottom <= root.clientHeight + 1,
      };
    })()`);
    stops.push(at.id || (at.cls ? '.' + at.cls.split(' ')[0] : at.tag));
    if (at.id === 'skipToComposer' && want.skip < 0) { want.skip = i; skipShown = at; }
    if (at.lens && want.lens < 0) want.lens = i;
    if (at.id === 'promptInput' && want.prompt < 0) want.prompt = i;
    if (at.rail && want.rail < 0) want.rail = i;
    if (want.skip > 0 && want.lens > 0 && want.prompt > 0 && want.rail > 0) break;
  }
  ok(want.lens > 0 && want.lens <= TAB_BUDGET,
    `B1 第 ${want.lens} 下 Tab 到达视角分段钮（预算 ≤${TAB_BUDGET}）`);
  ok(want.rail > 0 && want.rail <= TAB_BUDGET,
    `B2 第 ${want.rail} 下 Tab 到达左栏第一行的标题按钮（行本身故意不进 Tab 序，见 steward-board.js bindRowClick 头注；预算 ≤${TAB_BUDGET}）`);
  console.log(`NOTE 裸 Tab 距离：到 #promptInput 要 ${want.prompt} 下（.msg-actions 随对话长度增长，这是 U05 抓到的那条产品债的体温计，不当判据）`);
  console.log(`NOTE Tab 序实测前 ${stops.length} 站：${JSON.stringify(stops)}`);
  // 第一下 Tab 常常只是把焦点【从浏览器外壳送进文档】（activeElement 仍是 body，无头 Edge 实测
  // stops[0] 恒为 'BODY'）—— 所以判据是「第一个真正落到元素上的 Tab 站」，不是「第 1 下」。
  const firstStop = stops.find(name => name !== 'BODY') || '';
  ok(firstStop === 'skipToComposer',
    `B3 Tab 序的第一站就是跳转链接 #skipToComposer（实得「${firstStop}」，落在第 ${want.skip} 下）—— 它必须是整个应用的第一枚可聚焦元素`);
  // 拿到焦点后它要滑进来。这一下【等过渡走完再量】：transform 上挂着 --dur-fast 的过渡，
  // 紧跟着 Tab 读矩形量到的是过渡起点（第一版实测 y=-95，正是 translateY(-300%) 那一刻）。
  const skipFocused = await (async () => {
    await cdp.evaluate(`(() => { const n = document.getElementById('skipToComposer'); if (n) n.focus(); return true; })()`);
    await sleep(400);
    return cdp.evaluate(`(() => {
      const node = document.getElementById('skipToComposer');
      if (!node) return null;
      const b = node.getBoundingClientRect();
      const root = document.documentElement;
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return {
        rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
        focused: document.activeElement === node,
        text: (node.textContent || '').trim(),
        inside: b.width > 2 && b.height > 2 && b.left >= -1 && b.top >= -1 && b.right <= root.clientWidth + 1 && b.bottom <= root.clientHeight + 1,
        onTop: Boolean(hit) && (hit === node || node.contains(hit)),
      };
    })()`);
  })();
  ok(Boolean(skipFocused) && skipFocused.focused && skipFocused.inside && skipFocused.onTop && Boolean(skipFocused.text),
    `B3b 它拿到焦点就滑进来、整个在视口里、且在最上面（平时被 translateY 收到顶栏上方、由 .app-frame 的 overflow:hidden 裁掉；实测「${skipFocused && skipFocused.text}」 ${JSON.stringify(skipFocused && skipFocused.rect)}）`);
  void skipShown;
  // 同样要等过渡走完（回去那一程也挂着 --dur-fast）。
  await cdp.evaluate(`(() => { const n = document.getElementById('skipToComposer'); if (n) n.blur(); return true; })()`);
  await sleep(400);
  const skipHome = await cdp.evaluate(`(() => {
    const node = document.getElementById('skipToComposer');
    if (!node) return null;
    const b = node.getBoundingClientRect();
    const root = document.documentElement;
    return { bottom: Math.round(b.bottom), overflowX: root.scrollWidth - root.clientWidth, overflowY: root.scrollHeight - root.clientHeight };
  })()`);
  ok(Boolean(skipHome) && skipHome.bottom <= 0 && skipHome.overflowX <= 1 && skipHome.overflowY <= 1,
    `B3c 没焦点时它收在视口【上方】、不制造任何方向的滚动（bottom ${skipHome && skipHome.bottom}px，横向溢出 ${skipHome && skipHome.overflowX}px，纵向 ${skipHome && skipHome.overflowY}px）`);

  // Enter：焦点直送【当前视角】的输入框。两个视角各量一遍。
  const jumpTo = async (lens, expected) => {
    await setLens(lens);
    await cdp.evaluate(`(() => { const n = document.getElementById('skipToComposer'); if (n) n.focus(); return true; })()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
    await sleep(250);
    return cdp.evaluate(`(() => (document.activeElement && document.activeElement.id) || '')()`);
  };
  const jumpedClassic = await jumpTo('classic', 'promptInput');
  ok(jumpedClassic === 'promptInput',
    `B4 工作台视角：焦点在跳转链接上按 Enter，焦点落进 #promptInput（实得「${jumpedClassic}」）—— 一下 Tab ＋ 一下 Enter，与对话有多长无关`);
  const jumpedSteward = await jumpTo('steward', 'stewardComposerInput');
  ok(jumpedSteward === 'stewardComposerInput',
    `B5 管家视角：同一枚链接落进 #stewardComposerInput（实得「${jumpedSteward}」）—— 它读 data-shell-mode，不自己写`);
  await setLens('classic');

  /* ═════════ C 窄屏 800×900 ═════════ */
  const midMetrics = await resize(MID_W, MID_H);
  ok(Boolean(midMetrics) && midMetrics.w === MID_W, `C0 视口已压到 ${MID_W}×${MID_H}（实测 ${midMetrics && midMetrics.w}）`);
  const narrow = await cdp.evaluate(`(() => {
    const root = document.documentElement;
    const vw = root.clientWidth;
    const rail = document.getElementById('sidebar');
    const messages = document.getElementById('messages');
    const railBox = rail ? rail.getBoundingClientRect() : null;
    const chatBox = messages ? messages.getBoundingClientRect() : null;
    return {
      vw,
      overflow: root.scrollWidth - vw,
      railW: railBox ? Math.round(railBox.width) : -1,
      // 折叠这一档的可见判据：标题、搜索框都收起来了（DOM 一个节点不少，只是不显示）。
      titleHidden: rail ? getComputedStyle(rail.querySelector('.rail-title')).display === 'none' : false,
      searchHidden: rail ? getComputedStyle(rail.querySelector('.search-wrap')).display === 'none' : false,
      chatW: chatBox ? Math.round(chatBox.width) : -1,
      chatRatio: chatBox ? Math.round((chatBox.width / vw) * 1000) / 10 : -1,
    };
  })()`);
  ok(narrow.railW > 0 && narrow.railW <= 60 && narrow.titleHidden && narrow.searchHidden,
    `C1 左栏折叠规则真的生效：@container frame (max-width: 980px) 把左栏折成 ${narrow.railW}px 图标栏（栏头标题与搜索框 display:none）`);
  ok(narrow.overflow <= 1, `C2 ${MID_W}px 下整页仍无横向滚动（差 ${narrow.overflow}px）`);
  ok(narrow.chatRatio >= 60,
    `C3 对话区宽度 ≥ 视口 60%（实测 ${narrow.chatW}px / ${narrow.vw}px = ${narrow.chatRatio}%）`);

  await cdp.send('Emulation.clearDeviceMetricsOverride');
} catch (error) {
  fail += 1;
  console.log('FAIL 未捕获异常：' + (error && error.stack || error));
} finally {
  if (cdp) cdp.close();
  killTree(browser);
  stopRuyiTestBrowsers();
  killTree(server);
  if (provider) await new Promise(resolve => provider.close(resolve));
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
}
console.log(fail === 0 ? 'A11Y WALKTHROUGH BROWSER E2E: ALL PASS' : `A11Y WALKTHROUGH BROWSER E2E: FAILURES ${fail}`);
process.exit(fail === 0 ? 0 : 1);
})();
