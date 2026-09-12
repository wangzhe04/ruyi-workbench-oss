#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离（见 lib 头注）

// 121 波「一台两视」**用户走查修复第一轮** 的真浏览器 E2E（34 号文 §2.2／§2.3／§2.5／§2.10.3／§3.1）。
//
// 用户 2026-09-13 对着真机走查报了五条，本件给每一条钉一组「屏幕上真的是那样」的事实：
//   ① 顶栏右侧的就地浮层（盾牌菜单／齿轮菜单）不许被右栏盖住 —— 判据是 elementFromPoint：
//      菜单矩形里的三个点打下去，落到的都得是菜单自己的子节点。两视角各一遍（管家视角右栏是
//      #stewardSide，工作台视角右栏是 #toolPane）。
//   ② 左栏普通密度：整行可点（点行里任意一块【不是按钮】的地方就切过去），且【不出】那一排
//      悬停动作 —— 那一排只属「看板」密度；普通密度只在行尾留一枚「⋯」，点开是【同一份】动作表。
//   ③ 管家的「另起一件」与工作台的「新线程」看得出差别：同一枚 #newSessionBtn，两视角的
//      文案／字形／底色三样都不同。
//   ④ 线程头 chip 的弹层不许与「对话｜班组」页签叠画：同 ① 的 elementFromPoint 判据，外加
//      「底色是实底」（alpha ≥ .9 或带 backdrop-filter，§2.10.3 浮层材质）。三处宿主各一遍。
//   ⑤ 线程头切模型【要看得见地生效】：PATCH 恰一发 → 服务端回读变了 → 组合根手里那份会话
//      （state.currentSession.engineRoute）跟着变 → 线程头 chip／空态「当前引擎」那行／
//      #statusLine 的 title 三处回显同步变 → 有一条看得见的回执 → 下一回合真打到新模型
//      （fake provider 抓 model 字段）。
//
// 夹具：A 停在 question 待决（等你，且【会话级权限档】与全局不同 —— ④ 第三处宿主要它印出 chip）、
// B 的回合一直挂着（在跑）、C 一句短回答收尾（今天收工）、D 一条【空】线程（⑤ 要空态那行字）。
// A＋B 挂在同一个事项容器下（多线程任务），C／D 各自成一件。后端零改动。
// 与 one-workbench-frame.browser.e2e.js／workbench-thread-head.browser.e2e.js 同一套 CDP 无头驱动。
//
// 截图落点：默认在夹具临时目录，设了 RUYI_SHOT_DIR 就落到那里（交付报告要贴那两张）。
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
const zh = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const THREAD_A = '等华南的表';       // 停在 question 待决 → 等你（会话级权限档与全局不同）
const THREAD_B = '跑批处理';         // 回合一直挂着 → 在跑
const THREAD_C = '选个框架';         // 一句短回答收尾 → 今天收工（② 点它的行）
const THREAD_D = '空的那一条';       // 没有任何消息 → ⑤ 要工作台中栏那张空态
const MISSION_TITLE = '季度收尾';    // A＋B 的事项容器（多线程任务）
const POLL_MS = 120000;              // 兜底节拍拉满：本件不测节拍，别让它插队重画
const MODEL_1 = 'fake-model';
const MODEL_2 = 'fake-model-2';

function request(port, method, pathname, body, token, timeoutMs = 20000) {
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
    if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* already exited */ }
}

// 确定性 provider：'ask' → 一条 request_user_input（挂成 question 待决）；'hang' → 只开流不收尾；
// 其余 → 一句短回答。**每一发都把请求体里的 model 记下来**（⑤ 的 F8 判据：切了模型之后
// 下一回合真的打到新模型上 —— 这是「生效」的最硬那一半，与前端回显无关）。
const openSockets = [];
const seenModels = [];
async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(`{"data":[{"id":"${MODEL_1}"},{"id":"${MODEL_2}"}]}`);
    }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try { seenModels.push(String((JSON.parse(raw) || {}).model || '')); } catch { seenModels.push(''); }
    // 认这一支只看夹具自己那两句【独一无二】的话（易变前缀与工具结果会搅乱「最后一条 user 消息」）。
    const intent = raw.includes('hang here') ? 'hang' : (raw.includes('ask about south') ? 'ask' : 'short');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = payload => res.write('data: ' + JSON.stringify(payload) + '\n\n');
    if (intent === 'ask') {
      const args = JSON.stringify({ questions: [{
        id: 'south', header: 'South', question: '华南那张表要等吗？', answerMode: 'single',
        options: [{ id: 'wait', label: '等' }, { id: 'skip', label: '不等' }],
      }] });
      frame({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_w1_q', type: 'function', function: { name: 'request_user_input', arguments: '' } }] }, finish_reason: null }] });
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } , finish_reason: null }] });
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (intent === 'hang') {
      openSockets.push(res);
      frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '在跑…' }, finish_reason: null }] });
      return;   // 刻意不收尾：这一条永远「在跑」
    }
    frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '好，就它了。' }, finish_reason: null }] });
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

// 预算 800 × 40ms = 32 s：并行全量下几个无头浏览器抢 CPU（与同族五件同一个数）。
async function waitForEval(cdp, expression, attempts = 800) {
  for (let i = 0; i < attempts; i++) {
    try {
      const value = await cdp.evaluate(expression);
      if (value) return value;
    } catch { /* reload 会换执行上下文 */ }
    await sleep(40);
  }
  return null;
}

const READY = `(() => {
  if (!window.state || !window.state.status || !window.state.config || !window.state.config.configSchema) return null;
  if (!document.getElementById('railList') || !document.getElementById('appFrame')) return null;
  const button = document.querySelector('#lensSeg [data-lens]');
  if (!button || typeof button.onclick !== 'function') return null;
  if (!document.querySelector('#threadChips .steward-chip')) return null;
  return { ready: true };
})()`;

// ①／④ 共用的判据：一块浮层【真的在最上面】。取矩形里三个点（中心与两个内角），
// elementFromPoint 落到的必须是浮层自己或它的后代 —— 被别的面盖住时落到的是那个面。
// 顺带把「它长什么样」也带回来：底色（§2.10.3 浮层要实底或玻璃材质）与 z-index。
function overlayProbe(selector) {
  return `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return { found: false };
    if (node.hidden) return { found: true, open: false };
    const b = node.getBoundingClientRect();
    if (b.width < 8 || b.height < 8) return { found: true, open: false, w: b.width, h: b.height };
    const pts = [
      [b.x + b.width / 2, b.y + b.height / 2],
      [b.x + 6, b.y + 6],
      [b.right - 6, b.bottom - 6],
    ];
    const hits = pts.map(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      if (!hit) return 'null';
      if (hit === node || node.contains(hit)) return 'self';
      return (hit.id ? '#' + hit.id : '') + '.' + String(hit.className || hit.tagName || '?').split(' ').join('.');
    });
    const cs = getComputedStyle(node);
    return {
      found: true, open: true, hits,
      onTop: hits.every(h => h === 'self'),
      bg: cs.backgroundColor,
      backdrop: String(cs.backdropFilter || cs.webkitBackdropFilter || 'none'),
      z: cs.zIndex,
      rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
    };
  })()`;
}

// 「实底或浮层材质」：rgba 的 alpha ≥ .9，或者带了 backdrop-filter（§2.10.3 说 --glass-* 只给浮层）。
function solidEnough(probe) {
  if (!probe || !probe.open) return false;
  const match = String(probe.bg || '').match(/^rgba?\(([^)]+)\)$/);
  const parts = match ? match[1].split(',').map(s => Number(s.trim())) : [];
  const alpha = parts.length >= 4 ? parts[3] : 1;
  const blurred = probe.backdrop && probe.backdrop !== 'none';
  return alpha >= 0.9 || Boolean(blurred);
}

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-walkthrough-r1-'));
const home = path.join(root, 'home');
const workA = path.join(root, 'work-a');
const workB = path.join(root, 'work-b');
const workC = path.join(root, 'work-c');
const workD = path.join(root, 'work-d');
const profile = path.join(root, 'profile');
for (const dir of [home, workA, workB, workC, workD]) fs.mkdirSync(dir, { recursive: true });
const shotDir = process.env.RUYI_SHOT_DIR && fs.existsSync(process.env.RUYI_SHOT_DIR) ? process.env.RUYI_SHOT_DIR : root;
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
    baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: MODEL_1,
    models: [{ id: MODEL_1, label: 'Fake' }, { id: MODEL_2, label: 'Fake 2' }],
  }],
}), 'utf8');

let provider = null;
let server = null;
let browser = null;
let cdp = null;
const shots = {};
try {
  provider = await startProvider(providerPort);
  server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
    windowsHide: true, stdio: 'ignore',
  });
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200)), 'A1 workbench started');

  let token = '';
  for (let i = 0; i < 80 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A2 runtime token 可读');

  const created = {};
  for (const [key, title, cwd] of [['A', THREAD_A, workA], ['B', THREAD_B, workB], ['C', THREAD_C, workC], ['D', THREAD_D, workD]]) {
    const response = await request(appPort, 'POST', '/api/sessions', { title, cwd }, token);
    created[key] = response && response.json && response.json.session && response.json.session.id;
    await request(appPort, 'POST', '/api/mission', {
      sessionId: created[key], action: 'start', goal: title,
      milestones: [{ id: 'm1', desc: '第一步' }],
    }, token);
  }
  ok(Boolean(created.A && created.B && created.C && created.D), `A3 四条线程已建（${created.A} / ${created.B} / ${created.C} / ${created.D}）`);
  if (!created.A || !created.B || !created.C || !created.D) throw new Error('session fixtures unavailable');

  // ④ 第三处宿主（左栏行上的 chip）只在「这条线程跟全局不一样」时才印（chipsWorthPrinting），
  // 所以给 A 钉一个会话级权限档 —— 这不是为了测权限，是为了让那一行真的长出一枚 chip 来。
  const permPatch = await request(appPort, 'PATCH', `/api/sessions/${encodeURIComponent(created.A)}`, { permissionMode: 'plan' }, token);
  ok(Boolean(permPatch && permPatch.status === 200), 'A4 线程 A 钉了会话级权限档（左栏那一行才会印出 chip）');

  const container = await request(appPort, 'POST', '/api/missions', {
    title: MISSION_TITLE, acceptance: [{ text: '汇总表交付', done: true }, { text: '对账通过', done: false }],
  }, token);
  const missionId = container && container.json && container.json.mission && container.json.mission.missionId;
  ok(Boolean(missionId), `A5 事项容器已建（${missionId || '失败'}）`);
  for (const id of [created.A, created.B]) {
    await request(appPort, 'POST', `/api/missions/${encodeURIComponent(missionId)}/threads`, { action: 'attach', sessionId: id }, token);
  }

  await request(appPort, 'POST', '/api/chat/stream', { sessionId: created.C, message: 'short answer', cwd: workC }, token, 600000);
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.A, message: 'ask about south', cwd: workA }, token, 600000);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return pending.some(item => item && item.type === 'question' && item.sessionId === created.A);
  }, token)), 'A6 线程 A 停在 question 待决（等你）');
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.B, message: 'hang here', cwd: workB }, token, 600000);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === created.B);
    return Boolean(row && row.activeTurn === true);
  }, token)), 'A7 线程 B 的回合一直在飞（在跑）');

  const executable = findBrowserExecutable();
  ok(Boolean(executable), 'A8 Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1920,1080',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A9 browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // ⑤ 的探针：包住 window.fetch 数【写请求】并记下回来的状态码。必须在页面脚本之前装
  // （addScriptToEvaluateOnNewDocument ＋ reload）—— 这是本仓「包住宿主 API 数事实」的既有手法。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const native = window.fetch.bind(window);
      window.__w1 = { posts: [] };
      window.__w1Reset = () => { window.__w1.posts.length = 0; return true; };
      window.fetch = (input, init) => {
        let entry = null;
        try {
          const url = String(typeof input === 'string' ? input : (input && input.url) || '');
          const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
          if (method !== 'GET') {
            entry = { line: method + ' ' + url.replace(/^https?:\\/\\/[^/]+/, '').split('?')[0], status: 0 };
            window.__w1.posts.push(entry);
          }
        } catch { /* 记账失败不该影响请求本身 */ }
        const out = native(input, init);
        if (entry) out.then(r => { entry.status = r.status; }, () => { entry.status = -1; });
        return out;
      };
    })();`,
  });
  await cdp.evaluate('location.reload(); true');
  ok(Boolean(await waitForEval(cdp, READY)), 'A10 首屏就绪（config 真到达、线程头与那组 chip 已挂上）');
  await waitForEval(cdp, `(() => document.querySelectorAll('#railList .steward-board-thread').length >= 4 ? 1 : null)()`);

  const setLens = async lens => {
    await cdp.evaluate(`(document.querySelector('#lensSeg [data-lens="${lens}"]') || { click() {} }).click(), true`);
    return waitForEval(cdp, `(() => document.documentElement.getAttribute('data-shell-mode') === '${lens}'
      && !document.documentElement.dataset.vt ? 1 : null)()`);
  };
  // 真鼠标：CSS 的 :hover 与 elementFromPoint 都要真的命中测试，所以点击一律走 CDP Input
  // （.click() 绕过命中测试，恰恰测不到「被谁盖住了」这件事）。
  const mouseAt = async (x, y, type) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1,
  });
  const realClick = async (x, y) => { await mouseAt(x, y, 'mouseMoved'); await mouseAt(x, y, 'mousePressed'); await mouseAt(x, y, 'mouseReleased'); };
  const clickSelector = async selector => {
    const box = await cdp.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const b = node.getBoundingClientRect();
      if (b.width < 2 || b.height < 2) return null;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    })()`);
    if (!box) return false;
    await realClick(box.x, box.y);
    await sleep(120);
    return true;
  };
  const openSessionInWorkbench = async sessionId => {
    await cdp.evaluate(`(() => {
      const row = document.querySelector('#railList .steward-board-thread[data-session-id="${sessionId}"] .steward-board-thread-title');
      if (row) row.click();
      return true;
    })()`);
    return waitForEval(cdp, `(() => (window.state && window.state.currentSession && window.state.currentSession.id === '${sessionId}') ? 1 : null)()`);
  };
  const shoot = async name => {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(shotDir, name);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    shots[name] = file;
    return file;
  };

  /* ═════════ ① 顶栏的就地浮层不许被右栏盖住（§2.2）═════════
     反向验证：把 css/layout.css 里 .app-topbar 的 z-index 改回 1（或整条删掉）→ B1/B2/B3 当场红。 */
  // 盾牌与齿轮那两块浮层各自记着「我开着没有」（steward-settings.js 的 shieldOpen／app-frame.js 的
  // 同款标记），所以【只能靠那枚钮开合】—— 从外面把 menu.hidden 写成 true 会让那个标记与 DOM 对不上，
  // 下一次点它就变成「关」（第一轮就这么写，实测偶发 B0/B1 红：那不是产品的问题，是夹具的）。
  const toggleMenuUntil = async (buttonSelector, menuSelector, wantOpen) => {
    for (let i = 0; i < 4; i++) {
      const state = await cdp.evaluate(`(() => { const m = document.querySelector(${JSON.stringify(menuSelector)});
        return m ? (m.hidden ? 'closed' : 'open') : 'missing'; })()`);
      if (state === (wantOpen ? 'open' : 'closed')) return true;
      await clickSelector(buttonSelector);
      await sleep(220);
    }
    return false;
  };

  await setLens('steward');
  ok(await toggleMenuUntil('#stewardShieldBtn', '#stewardShieldMenu', true), 'B0 管家视角：盾牌菜单真的展开了');
  const shieldSteward = await cdp.evaluate(overlayProbe('#stewardShieldMenu'));
  ok(Boolean(shieldSteward && shieldSteward.onTop),
    `B1 管家视角：盾牌菜单在最上面 —— 菜单矩形三点 elementFromPoint 都落在菜单自己身上（实测 ${JSON.stringify(shieldSteward && shieldSteward.hits)}）`);
  await shoot('walkthrough-r1-steward-shield.png');
  await toggleMenuUntil('#stewardShieldBtn', '#stewardShieldMenu', false);

  await setLens('classic');
  ok(await toggleMenuUntil('#stewardShieldBtn', '#stewardShieldMenu', true), 'B1b 工作台视角：盾牌菜单真的展开了');
  const shieldClassic = await cdp.evaluate(overlayProbe('#stewardShieldMenu'));
  ok(Boolean(shieldClassic && shieldClassic.onTop),
    `B2 工作台视角：盾牌菜单在最上面（右栏「项目与进度」不许盖它；实测 ${JSON.stringify(shieldClassic && shieldClassic.hits)}）`);
  await toggleMenuUntil('#stewardShieldBtn', '#stewardShieldMenu', false);
  ok(await toggleMenuUntil('#appGearBtn', '#appGearMenu', true), 'B2b 工作台视角：齿轮菜单真的展开了');
  const gearClassic = await cdp.evaluate(overlayProbe('#appGearMenu'));
  ok(Boolean(gearClassic && gearClassic.onTop),
    `B3 工作台视角：齿轮菜单在最上面（实测 ${JSON.stringify(gearClassic && gearClassic.hits)}）`);
  await toggleMenuUntil('#appGearBtn', '#appGearMenu', false);
  // 层级关系写死一次：顶栏要压得住右栏（右栏抽屉档是 30、右栏拖拽手柄 46 在另一头），
  // 又【不许】压住模态（.modal-backdrop 50）与浮层原语（.popover 55）。
  const layers = await cdp.evaluate(`(() => {
    const bar = document.querySelector('.app-topbar');
    const cs = bar ? getComputedStyle(bar) : null;
    return { z: cs ? cs.zIndex : '', position: cs ? cs.position : '' };
  })()`);
  const topZ = Number(layers && layers.z);
  ok(Number.isFinite(topZ) && topZ >= 31 && topZ < 44 && layers.position !== 'static',
    `B4 .app-topbar 自己有层级：定位非 static、z-index 在「压得住右栏(30)、压不住抽屉遮罩(44)/模态(50)/浮层(55)」这一档（实测 ${JSON.stringify(layers)}）`);

  /* ═════════ ② 左栏普通密度：整行可点、不出悬停动作栏（§2.3）═════════
     反向验证：把 steward-board.js 里 item.onclick 那一行删掉 → C1/C2 红；
               把 steward-board.css 里 .rail-board 那两条 hover 规则改回不带 .rail-board → C4 红。 */
  // 行里找一个【不是按钮】的点：这就是用户说的「那一块区域」。
  const blankPointIn = sessionId => `(() => {
    const row = document.querySelector('#railList .steward-board-thread[data-session-id="${sessionId}"]');
    if (!row) return null;
    const b = row.getBoundingClientRect();
    for (let ty = 3; ty < b.height - 3; ty += 3) {
      for (let tx = 3; tx < b.width - 3; tx += 6) {
        const x = b.x + tx, y = b.y + ty;
        const hit = document.elementFromPoint(x, y);
        if (!hit || !row.contains(hit)) continue;
        if (hit.closest('button, a, input, select, textarea, label')) continue;
        return { x, y, cls: String(hit.className || hit.tagName || '') };
      }
    }
    return null;
  })()`;

  await openSessionInWorkbench(created.C);
  const blankD = await cdp.evaluate(blankPointIn(created.D));
  ok(Boolean(blankD), `C0 左栏行里找得到一块【不是按钮】的地方（实测 ${JSON.stringify(blankD)}）`);
  if (blankD) {
    await realClick(blankD.x, blankD.y);
    const switched = await waitForEval(cdp,
      `(() => (window.state && window.state.currentSession && window.state.currentSession.id === '${created.D}') ? 1 : null)()`, 60);
    ok(Boolean(switched), 'C1 工作台视角：点行里那块空白 → 中栏真的换成了这条线程（§2.3 点击语义＝整行）');
  } else ok(false, 'C1 工作台视角：点行里那块空白 → 中栏换线程（没找到可点的空白）');

  await setLens('steward');
  await waitForEval(cdp, `(() => document.querySelectorAll('#railList .steward-board-thread').length >= 4 ? 1 : null)()`);
  const selBefore = await cdp.evaluate(`(() => { const n = document.querySelector('#railList .steward-board-thread.is-sel'); return n ? (n.dataset.sessionId || '') : ''; })()`);
  const blankC = await cdp.evaluate(blankPointIn(created.C));
  if (blankC) {
    await realClick(blankC.x, blankC.y);
    const focused = await waitForEval(cdp,
      `(() => { const n = document.querySelector('#railList .steward-board-thread.is-sel'); return (n && n.dataset.sessionId === '${created.C}') ? 1 : null; })()`, 80);
    ok(Boolean(focused), `C2 管家视角：点行里那块空白 → 焦点真的换了（原来是 ${selBefore || '（无）'}）`);
  } else ok(false, 'C2 管家视角：点行里那块空白 → 焦点换（没找到可点的空白）');

  // 悬停：普通密度不出动作栏，看板密度出。两档各量一次，反面也量。
  const hoverRowAndRead = async sessionId => {
    const box = await cdp.evaluate(`(() => {
      const row = document.querySelector('#railList .steward-board-thread[data-session-id="${sessionId}"]');
      if (!row) return null;
      const b = row.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + 8 };
    })()`);
    if (!box) return null;
    await mouseAt(box.x, box.y, 'mouseMoved');
    await sleep(160);
    return cdp.evaluate(`(() => {
      const row = document.querySelector('#railList .steward-board-thread[data-session-id="${sessionId}"]');
      if (!row) return null;
      const actions = row.querySelector('.steward-board-actions');
      const more = row.querySelectorAll('.steward-board-more');
      return {
        actions: actions ? getComputedStyle(actions).display : '(无)',
        moreCount: more.length,
        moreDisplay: more.length ? getComputedStyle(more[0]).display : '(无)',
        boardMode: document.getElementById('appFrame') ? document.getElementById('appFrame').classList.contains('rail-board') : null,
      };
    })()`);
  };
  const normalHover = await hoverRowAndRead(created.C);
  ok(Boolean(normalHover && normalHover.actions === 'none'),
    `C3 普通密度：悬停一行【不】出那一排动作（实测 display=${normalHover && normalHover.actions}）`);
  ok(Boolean(normalHover && normalHover.moreCount === 1 && normalHover.moreDisplay !== 'none'),
    `C4 普通密度：行尾恰有一枚「⋯」，悬停时可见（实测 ${normalHover && normalHover.moreCount} 枚 / display=${normalHover && normalHover.moreDisplay}）`);

  // 「⋯」点开的是【同一份】动作表：置顶／重命名／删除三枚都在里面。
  const moreOpened = await cdp.evaluate(`(() => {
    const row = document.querySelector('#railList .steward-board-thread[data-session-id="${created.C}"]');
    const btn = row && row.querySelector('.steward-board-more');
    if (!btn) return null;
    btn.click();
    const actions = row.querySelector('.steward-board-actions');
    const labels = actions ? [...actions.querySelectorAll('button')].map(b => (b.dataset.sessionAction || b.dataset.action || b.dataset.newThread ? (b.dataset.sessionAction || b.dataset.action || 'new-thread') : '')) : [];
    return { display: actions ? getComputedStyle(actions).display : '(无)', labels, open: row.classList.contains('is-actions-open') };
  })()`);
  ok(Boolean(moreOpened && moreOpened.display !== 'none' && moreOpened.labels.includes('pin')
    && moreOpened.labels.includes('rename') && moreOpened.labels.includes('delete')),
    `C5 「⋯」点开的就是那一份动作表（置顶／重命名／删除都在里面；实测 ${JSON.stringify(moreOpened)}）`);
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
  await sleep(120);

  await clickSelector('#railBoardBtn');
  await sleep(200);
  const boardHover = await hoverRowAndRead(created.C);
  ok(Boolean(boardHover && boardHover.boardMode === true && boardHover.actions === 'flex'),
    `C6 看板密度：悬停一行【出】那一排动作（§2.3「悬停动作只属看板密度」；实测 ${JSON.stringify(boardHover)}）`);
  ok(Boolean(boardHover && boardHover.moreDisplay === 'none'),
    `C7 看板密度：「⋯」让位（动作表已经铺开了，不要两条路；实测 display=${boardHover && boardHover.moreDisplay}）`);
  await clickSelector('#railBoardBtn');
  await sleep(200);

  /* ═════════ ③ 「＋」两义看得出差别（§2.3／§2.10.4）═════════
     反向验证：把 css 里 #newSessionBtn[data-lens="steward"] 那一条删掉 → D3 红。 */
  const plusIn = async lens => {
    await setLens(lens);
    await sleep(150);
    return cdp.evaluate(`(() => {
      const b = document.getElementById('newSessionBtn');
      if (!b) return null;
      const cs = getComputedStyle(b);
      return {
        lens: b.dataset.lens || '',
        icon: b.dataset.icon || '',
        label: (document.getElementById('newSessionBtnLabel') || {}).textContent || '',
        // 派单稿写「计算样式 background-color 各不同」—— 本仓证伪：button.primary 是
        // background: linear-gradient(...)（css/base.css:56），两边的 background-color 都是
        // rgba(0,0,0,0)，真正画出底色的是 background-image。所以三样一起看。
        bg: cs.backgroundColor,
        bgImage: cs.backgroundImage,
        border: cs.borderTopColor + '/' + cs.borderTopStyle,
      };
    })()`);
  };
  const plusSteward = await plusIn('steward');
  const plusClassic = await plusIn('classic');
  ok(Boolean(plusSteward && plusClassic && plusSteward.lens === 'steward' && plusClassic.lens === 'classic'),
    `D1 「＋」按钮自己说得出它此刻是哪一义（data-lens；实测 ${plusSteward && plusSteward.lens} / ${plusClassic && plusClassic.lens}）`);
  ok(Boolean(plusSteward && plusClassic
    && plusSteward.label === zh['rail.newTask'] && plusClassic.label === zh['rail.newThread']
    && plusSteward.label !== plusClassic.label && plusSteward.icon !== plusClassic.icon),
    `D2 两视角的文案与字形都不同（实测 「${plusSteward && plusSteward.label}」/${plusSteward && plusSteward.icon} ↔ 「${plusClassic && plusClassic.label}」/${plusClassic && plusClassic.icon}）`);
  ok(Boolean(plusSteward && plusClassic
    && plusSteward.bgImage === 'none' && /gradient/.test(String(plusClassic.bgImage))
    && plusSteward.border !== plusClassic.border),
    `D3 底色也不同 —— 工作台那一枚是主色实心（.primary 的渐变），管家那一枚是描边次级钮（实测 底 ${plusSteward && plusSteward.bgImage} / 边 ${plusSteward && plusSteward.border} ↔ 底 ${plusClassic && plusClassic.bgImage} / 边 ${plusClassic && plusClassic.border}）`);

  /* ═════════ ④ chip 弹层不许与页签条叠画（§2.10.3／§3.1）═════════
     反向验证：把 css/views/steward-drawer.css 的 .steward-chip-menu z-index 拿掉 → E1 红。 */
  await setLens('classic');
  ok(Boolean(await openSessionInWorkbench(created.C)), 'E0 工作台打开线程 C（线程头那一组 chip 就绪）');
  await clickSelector('#threadChips [data-chip="permission"]');
  const chipHead = await cdp.evaluate(overlayProbe('#threadChips .steward-chip-menu'));
  ok(Boolean(chipHead && chipHead.open), `E0b 线程头权限 chip 的菜单真的展开了（实测 ${JSON.stringify(chipHead && chipHead.rect)}）`);
  ok(Boolean(chipHead && chipHead.onTop),
    `E1 线程头 chip 菜单在最上面 —— 「对话｜班组」页签条与消息流都不许叠上来（实测 ${JSON.stringify(chipHead && chipHead.hits)}）`);
  ok(solidEnough(chipHead),
    `E2 chip 菜单是实底（alpha ≥ .9 或带 backdrop-filter，§2.10.3 浮层材质；实测 bg=${chipHead && chipHead.bg} backdrop=${chipHead && chipHead.backdrop}）`);
  await shoot('walkthrough-r1-classic-chipmenu.png');
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
  await sleep(150);

  await setLens('steward');
  await waitForEval(cdp, `(() => document.querySelector('#stewardDrawerChips .steward-chip') ? 1 : null)()`, 200);
  await clickSelector('#stewardDrawerChips [data-chip="permission"]');
  const chipFocus = await cdp.evaluate(overlayProbe('#stewardDrawerChips .steward-chip-menu'));
  ok(Boolean(chipFocus && chipFocus.open && chipFocus.onTop),
    `E3 管家视角焦点卡里的同一份 chip 菜单也在最上面（实测 ${JSON.stringify(chipFocus && chipFocus.hits)}）`);
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
  await sleep(150);

  // 第三处宿主：左栏行上的 chip（A 那一行 —— 它的权限档与全局不同，所以印得出来）。
  const railChipOpened = await cdp.evaluate(`(() => {
    const row = document.querySelector('#railList .steward-board-thread[data-session-id="${created.A}"]');
    const chip = row && row.querySelector('.steward-board-chips .steward-chip');
    if (!chip) return false;
    chip.click();
    return true;
  })()`);
  if (railChipOpened) {
    await sleep(160);
    const chipRail = await cdp.evaluate(overlayProbe(`#railList .steward-board-thread[data-session-id="${created.A}"] .steward-chip-menu`));
    ok(Boolean(chipRail && chipRail.open && chipRail.onTop),
      `E4 左栏行上的同一份 chip 菜单也在最上面（实测 ${JSON.stringify(chipRail && chipRail.hits)}）`);
    await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
    await sleep(150);
  } else ok(false, 'E4 左栏行上的 chip 菜单（那一行没印出 chip —— 夹具的会话级权限档没生效？）');

  /* ═════════ ⑤ 线程头切模型要【看得见地】生效（§2.5／§3.1）═════════
     反向验证：把 thread-head.js 的 adoptSession 那一行删掉 → F3/F5/F6 红；
               把 note 注入拿掉（回落写 #stewardDrawerNote）→ F7 红。 */
  await setLens('classic');
  ok(Boolean(await openSessionInWorkbench(created.D)), 'F0 工作台打开空线程 D（中栏是那张空态，「当前引擎」那一行在场）');
  const before = await cdp.evaluate(`(() => ({
    stateModel: String(((window.state.currentSession || {}).engineRoute || {}).model || ''),
    chip: (document.querySelector('#threadChips [data-chip="model"] .steward-chip-value') || {}).textContent || '',
    empty: (document.querySelector('.empty-engine') || {}).textContent || '',
    statusTitle: (document.getElementById('statusLine') || {}).title || '',
  }))()`);
  ok(Boolean(before && before.empty),
    `F0b 空态那一行「当前引擎」在场（实测「${before && before.empty}」）`);

  await cdp.evaluate('window.__w1Reset(), true');
  await clickSelector('#threadChips [data-chip="model"]');
  await waitForEval(cdp, `(() => document.querySelector('#threadChips .steward-chip-menu [data-model-id="${MODEL_2}"]') ? 1 : null)()`, 200);
  await clickSelector(`#threadChips .steward-chip-menu [data-model-id="${MODEL_2}"]`);
  await sleep(600);

  const posts = await cdp.evaluate('window.__w1.posts.slice()');
  const patches = (posts || []).filter(item => item.line === `PATCH /api/sessions/${created.D}`);
  ok(patches.length === 1 && patches[0].status === 200,
    `F1 切模型恰发一发 PATCH /api/sessions/:id 且 200（实测 ${JSON.stringify(posts)}）`);
  const readback = await request(appPort, 'GET', `/api/sessions/${encodeURIComponent(created.D)}`, null, token);
  const savedRoute = readback && readback.json && (readback.json.session || readback.json).engineRoute;
  ok(Boolean(savedRoute && savedRoute.model === MODEL_2),
    `F2 服务端回读：这条线程的 engineRoute.model 真的变了（实测 ${JSON.stringify(savedRoute)}）`);

  const after = await cdp.evaluate(`(() => ({
    stateModel: String(((window.state.currentSession || {}).engineRoute || {}).model || ''),
    chip: (document.querySelector('#threadChips [data-chip="model"] .steward-chip-value') || {}).textContent || '',
    empty: (document.querySelector('.empty-engine') || {}).textContent || '',
    statusTitle: (document.getElementById('statusLine') || {}).title || '',
    toast: [...document.querySelectorAll('.toast-tray *')].map(n => n.textContent || '').join(' | '),
  }))()`);
  ok(after && after.stateModel === MODEL_2,
    `F3 组合根手里那份会话跟着变了（state.currentSession.engineRoute.model；修前实测「${before && before.stateModel}」→ 现在「${after && after.stateModel}」）`);
  ok(Boolean(after && after.chip.includes(MODEL_2)),
    `F4 线程头模型 chip 的值变了（实测「${after && after.chip}」）`);
  ok(Boolean(after && after.empty.includes(MODEL_2)),
    `F5 空态「当前引擎：…」那一行跟着变了（实测「${after && after.empty}」）`);
  ok(Boolean(after && after.statusTitle.includes(MODEL_2)),
    `F6 #statusLine 的 title（服务商 · 模型）跟着变了（实测「${after && after.statusTitle}」）`);
  ok(Boolean(after && after.toast.includes(zh['stewardShell.chips.changed'])),
    `F7 切完有一条【看得见】的回执（工作台视角里 #stewardDrawerNote 是藏着的；实测「${after && after.toast}」）`);

  const modelsBefore = seenModels.length;
  await request(appPort, 'POST', '/api/chat/stream', { sessionId: created.D, message: 'short answer', cwd: workD }, token, 600000);
  const modelsAfter = seenModels.slice(modelsBefore);
  ok(modelsAfter.length > 0 && modelsAfter.every(model => model === MODEL_2),
    `F8 下一回合真的打到新模型上（fake provider 抓到的 model=${JSON.stringify(modelsAfter)}）`);

  // 引擎 chip：agent 引擎的路由形状（{engine:'agent', agentCliType:'kimi'}）也要写得进去、读得回来。
  await cdp.evaluate('window.__w1Reset(), true');
  await clickSelector('#threadChips [data-chip="engine"]');
  await waitForEval(cdp, `(() => document.querySelector('#threadChips .steward-chip-menu [data-engine-key="agent:kimi"]') ? 1 : null)()`, 200);
  await clickSelector(`#threadChips .steward-chip-menu [data-engine-key="agent:kimi"]`);
  await sleep(600);
  const engineBack = await request(appPort, 'GET', `/api/sessions/${encodeURIComponent(created.D)}`, null, token);
  const engineRoute = engineBack && engineBack.json && (engineBack.json.session || engineBack.json).engineRoute;
  const engineState = await cdp.evaluate(`(() => JSON.stringify((window.state.currentSession || {}).engineRoute || null))()`);
  ok(Boolean(engineRoute && engineRoute.engine === 'agent' && engineRoute.agentCliType === 'kimi'),
    `F9 切引擎也写得进去（agent 路由形状；服务端回读 ${JSON.stringify(engineRoute)}）`);
  ok(Boolean(engineState && engineState.includes('kimi')),
    `F10 切引擎之后组合根手里那份也跟着变（实测 ${engineState}）`);

  console.log('SHOTS ' + JSON.stringify(shots));
} catch (error) {
  fail += 1;
  console.log('FAIL 未捕获异常：' + (error && error.stack || error));
} finally {
  for (const socket of openSockets) { try { socket.end(); } catch { /* ignore */ } }
  if (cdp) cdp.close();
  killTree(browser);
  stopRuyiTestBrowsers();
  killTree(server);
  if (provider) await new Promise(resolve => provider.close(resolve));
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
}
console.log(fail === 0 ? 'ALL PASS' : `FAILURES ${fail}`);
process.exit(fail === 0 ? 0 : 1);
})();
