#!/usr/bin/env node
'use strict';

// 第117波 117h 真实浏览器 E2E（27 号文 §5 117h 行 / §8.10「多线程看板与注意力预算」/ §8.2 L1）。
// 造两个事项：M 下挂两条线程（A 停在 question 待决＝等你，B 的回合一直挂着＝在跑，两条各自的工作
// 文件夹不同，免得撞上 116h 的同 cwd 写互斥），C 自成事项。然后：
//   ① 进管家壳 → 一行状态说「2 个事项 · 1 条在跑，1 条等你」；
//   ② 点开看板 → 按事项分组（2 组）、事项行验收 a/b、线程行的等待原因、每行都有快切 chip；
//   ③ 「同时最多」改成 3 → GET /api/steward/arbiter.maxParallel === 3（116h 的即时生效）；
//   ④ 点「优先」→ 后端如实回「它没在排队」（116h 语义刻意做窄），界面照说不编成功；
//   ⑤ ≥1000px 时 #stewardNow 显示等你那条（focusThreadFor 的优先级）；
//   ⑥ 派发 steward:focus-thread → 切到另一条（显式选择覆盖自动挑选）；
//   ⑦ 「关掉」→ 回单列且 localStorage 记住；点某行「打开」→ 请得回来；
//   ⑧ 缩到 900px → 不常驻（抽屉退回覆盖式）；
//   ⑨ 切回经典壳 → 管家侧零残留定时器；
//   ⑩ 117s-B：给【右栏已经开着的、已收工的】线程递话 → 两条真实路径各钉一条（R 组）：强刷读得
//      太早时下一拍要真去复核（不被推后一整个空闲节拍），行上的「打开」这条不派事件的焦点路要强刷。
// 与 steward-drawer.e2e.js / steward-shell.e2e.js 同一套 CDP 无头驱动；后端零改动。
(async () => {
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');
const { stopRuyiTestBrowsers } = require('./lib/browser-cleanup');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const zh = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};
const fill = (key, params) => String(zh[key]).replace(/{{\s*([\w.-]+)\s*}}/g, (match, name) => (
  params[name] == null ? match : String(params[name])));

const MISSION_TITLE = '季度收尾';
const THREAD_A = '等华南的表';
const THREAD_B = '跑批处理';
const THREAD_C = '选个框架';
// 117r-D2：这一条【故意】等浏览器已经取过一趟行之后才建，专用来造「行还没刷到就派焦点事件」的时序。
const THREAD_D = '刚开的这一条';
// 117s-B：抽屉【已经开着的就是这一条】时递话进来的两条线程（都走无账本那一路，见 R 组的头注）。
// E 钉「强刷读得太早」那一条，F 钉「看板行上的『打开』不派事件」那一条。
const THREAD_E = '收工了又被叫醒';
const THREAD_F = '收工了又被点开';
const POLL_MS = 120000;   // 配置的节拍拉满：测试窗口内不会真的去拉，计时器只按周期数个数
// 117j W2-5：表按 5s 下限起（见 steward-board.js pollTick 头注），数计时器要按这个周期。
const TICK_MS = 5000;

const { findBrowserExecutable } = require('./lib/browser-path');
const browserPath = findBrowserExecutable;

function request(port, method, pathname, body, token) {
  return new Promise(resolve => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: 20000,
      headers: {
        ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
        ...(token ? { 'x-wcw-token': token } : {}),
      },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* NDJSON / non-json */ }
        resolve({ status: response.statusCode, text, json });
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (raw) req.write(raw);
    req.end();
  });
}

async function waitForHttp(port, method, pathname, predicate, token, attempts = 200) {
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

// 确定性 provider：'ask' → 一条 request_user_input（挂成 question 待决）；'hang' → 只开流不收尾
// （回合一直在飞，五态 = 在跑）；其余 → 一句话收尾。
const openSockets = [];
async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find(message => message && message.role === 'user');
    const text = String((lastUser && lastUser.content) || '');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const sse = value => res.write('data: ' + JSON.stringify(value) + '\n\n');
    if (/hang/i.test(text)) {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '开工了…' }, finish_reason: null }] });
      openSockets.push(res);            // 故意不收尾：这条回合一直在飞
      return;
    }
    if (/ask/i.test(text)) {
      const args = JSON.stringify({ questions: [{
        id: 'south', header: 'South', question: '华南那张表要等吗？', answerMode: 'single',
        options: [{ id: 'wait', label: '等' }, { id: 'skip', label: '不等' }],
      }] });
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_117h_q', type: 'function', function: { name: 'request_user_input', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '好了。' }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.write('data: [DONE]\n\n'); res.end();
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

// 等待预算 800 × 40ms = 32s：并行全量下四个无头浏览器抢 CPU，取数与渲染都会被拉长
// （117g 那件在 --parallel 4 里实测单趟就要一分钟量级）。单跑时用不到这么多，只是留够头寸。
async function waitForEval(cdp, expression, attempts = 800) {
  for (let i = 0; i < attempts; i++) {
    try {
      const value = await cdp.evaluate(expression);
      if (value) return value;
    } catch { /* reload swaps execution context */ }
    await sleep(40);
  }
  return null;
}

const READY = `(() => {
  const select = document.getElementById('cfgShellMode');
  if (!select || typeof select.onchange !== 'function') return null;
  if (!document.getElementById('stewardBoard') || !window.state || !window.state.status || !window.state.config) return null;
  return { ready: true };
})()`;

// 看板快照：全部走 textContent / 属性，不碰任何模块私有状态。
const BOARD = `(() => {
  const text = id => { const node = document.getElementById(id); return node ? node.textContent.trim() : ''; };
  const board = document.getElementById('stewardBoard');
  const now = document.getElementById('stewardNow');
  const drawer = document.getElementById('stewardDrawer');
  const line = document.getElementById('stewardStatusLine');
  return {
    statusLine: line ? line.textContent.trim() : '',
    expanded: line ? line.getAttribute('aria-expanded') : '',
    boardHidden: board ? board.hidden : null,
    boardRole: board ? board.getAttribute('role') : '',
    maxValue: (document.getElementById('stewardBoardMax') || {}).value || '',
    running: text('stewardBoardRunning'),
    queued: text('stewardBoardQueued'),
    note: text('stewardBoardNote'),
    groups: [...document.querySelectorAll('#stewardBoardList .steward-board-mission')].map(group => ({
      missionId: group.dataset.missionId || '',
      title: (group.querySelector('.steward-board-mission-title') || {}).textContent || '',
      pills: [...group.querySelectorAll('.steward-board-mission-head .steward-board-pill')].map(node => node.textContent.trim()),
      tone: (group.querySelector('.steward-board-mission-head .steward-board-dot') || {}).dataset?.tone || '',
      threads: [...group.querySelectorAll('.steward-board-thread')].map(item => ({
        sessionId: item.dataset.sessionId || '',
        title: (item.querySelector('.steward-board-thread-title') || {}).textContent || '',
        state: (item.querySelector('.steward-board-dot') || {}).dataset?.state || '',
        wait: (item.querySelector('.steward-board-wait') || {}).textContent || '',
        // 117l D4：行上那枚「它在问你」pill（只在 asksYou 非空时出现，点它＝打开抽屉）。
        asksYou: [...item.querySelectorAll('.steward-board-pill.is-asks-you')].map(node => node.textContent.trim()),
        chips: [...item.querySelectorAll('.steward-board-chips .steward-chip')].map(node => node.dataset.chip),
        actions: [...item.querySelectorAll('.steward-board-actions .steward-board-btn')].map(node => node.dataset.action),
      })),
    })),
    nowHidden: now ? now.hidden : null,
    nowThread: text('stewardDrawerTitle'),
    // 117s-B：右栏那一份抽屉的状态行与「它刚说／它正在说」——「递话进来之后屏幕上有没有变」
    // 的可判定形式（只读 textContent，不碰任何模块私有状态）。
    nowState: text('stewardDrawerState'),
    nowLastSayHead: text('stewardDrawerLastSayHead'),
    nowLastSay: text('stewardDrawerLastSayText'),
    drawerHidden: drawer ? drawer.hidden : null,
    drawerMount: drawer ? (drawer.dataset.mount || '') : '',
    drawerParent: drawer && drawer.parentElement ? drawer.parentElement.id : '',
    nowClosedPref: (() => { try { return localStorage.getItem('wcw.stewardNowClosed') || ''; } catch { return 'ERR'; } })(),
    intervals: window.__ruyiLiveIntervals ? window.__ruyiLiveIntervals() : [],
    // 117l-B2 ②（用户第五轮走查 2「这个限制界面优化美观一下」）：视觉那几件的可判定结果。
    // 全部读【计算样式】与公开属性，不看 CSS 源码（源码形状由 steward-board.static 的 I 组钉）。
    pauseAllDisabled: (() => {
      const btn = document.getElementById('stewardBoardPauseAllBtn');
      return btn ? btn.disabled : null;
    })(),
    topGround: (() => {
      const top = document.querySelector('#stewardBoard .steward-board-top');
      if (!top) return '';
      const style = getComputedStyle(top);
      return style.backgroundColor + '|' + style.backdropFilter;
    })(),
    missionGround: (() => {
      const card = document.querySelector('#stewardBoardList .steward-board-mission');
      if (!card) return '';
      const style = getComputedStyle(card);
      return style.backgroundColor + '|' + style.backdropFilter;
    })(),
    // 同一张卡里第二条线程行的上边线（分隔线）与整行的左缩进。
    threadRule: (() => {
      const rows = [...document.querySelectorAll('#stewardBoardList .steward-board-mission')]
        .map(card => [...card.querySelectorAll('.steward-board-thread')])
        .find(list => list.length >= 2) || [];
      if (rows.length < 2) return '';
      const first = getComputedStyle(rows[0]);
      const second = getComputedStyle(rows[1]);
      return first.borderTopWidth + '|' + second.borderTopWidth + '|' + second.marginInlineStart;
    })(),
    // 线程名在窄屏下有没有被挤没（走查 2 的返工点：0 宽 = 名字从屏幕上消失）。
    titleWidths: [...document.querySelectorAll('#stewardBoardList .steward-board-thread-title')]
      .map(node => Math.round(node.getBoundingClientRect().width)),
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-board-'));
const home = path.join(root, 'home');
const workA = path.join(root, 'work-a');
const workB = path.join(root, 'work-b');
// 117s-B：线程 E 自己的工作文件夹 —— 它要连跑两个回合（一个收尾、一个挂着），
// 与 A／B 同 cwd 会撞上 116h 的写互斥，那不是本组要测的形状。
const workE = path.join(root, 'work-e');
const workF = path.join(root, 'work-f');
const profile = path.join(root, 'profile');
for (const dir of [home, workA, workB, workE, workF]) fs.mkdirSync(dir, { recursive: true });
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
try {
  provider = await startProvider(providerPort);
  server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
    windowsHide: true, stdio: 'ignore',
  });
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200, undefined, 300)), 'A1 workbench started'); // 117q:此启动门原吃默认 attempts=200(200×80ms=16s)低于 30 号文 P1-31 建议的 300×同款间隔量级,是「FAIL workbench up」假红的根;默认值被本文件下方多处业务断言调用复用,不能整体抬,这里改成显式传 300 只抬这一处(30 号文 P1-31)

  let token = '';
  for (let i = 0; i < 80 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A2 runtime token 可读');

  // ── 造两个事项、三条线程 ───────────────────────────────────────────────────────
  const created = {};
  for (const [key, title, cwd] of [['A', THREAD_A, workA], ['B', THREAD_B, workB], ['C', THREAD_C, home]]) {
    const response = await request(appPort, 'POST', '/api/sessions', { title, cwd }, token);
    created[key] = response && response.json && response.json.session && response.json.session.id;
    await request(appPort, 'POST', '/api/mission', {
      sessionId: created[key], action: 'start', goal: title,
      milestones: [{ id: 'm1', desc: '第一步' }],
    }, token);
  }
  ok(Boolean(created.A && created.B && created.C), `A3 三条线程已建（${created.A} / ${created.B} / ${created.C}）`);
  if (!created.A || !created.B || !created.C) throw new Error('session fixtures unavailable');

  const container = await request(appPort, 'POST', '/api/missions', {
    title: MISSION_TITLE,
    acceptance: [{ text: '汇总表交付', done: true }, { text: '对账通过', done: false }],
  }, token);
  const missionId = container && container.json && container.json.mission && container.json.mission.missionId;
  ok(Boolean(missionId), `A4 事项容器已建（${missionId || '失败'}）`);
  for (const id of [created.A, created.B]) {
    await request(appPort, 'POST', `/api/missions/${encodeURIComponent(missionId)}/threads`, { action: 'attach', sessionId: id }, token);
  }

  // A：停在 question 待决（等你）。B：回合一直挂着（在跑）。两条各自的工作文件夹不同 ——
  // 116h 的同 cwd 写互斥会把后来的那条压成「等锁」，那不是本件要测的形状。
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.A, message: 'ask about south', cwd: workA }, token);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return pending.some(item => item && item.type === 'question' && item.sessionId === created.A);
  }, token)), 'A5 线程 A 停在 question 待决（等你）');
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.B, message: 'hang here', cwd: workB }, token);
  const running = await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === created.B);
    return Boolean(row && row.activeTurn === true);
  }, token);
  ok(Boolean(running), 'A6 线程 B 的回合一直在飞（在跑）');

  const rowsNow = (await request(appPort, 'GET', '/api/missions?limit=200', null, token)).json.missions || [];
  ok(rowsNow.length === 3 && rowsNow.filter(row => row.missionId === missionId).length === 2,
    `A7 三条线程都进了投影，其中两条挂在同一个事项下（实测 ${rowsNow.length} 行）`);
  ok(rowsNow.every(row => typeof row.missionTitle === 'string' && Array.isArray(row.acceptanceItems)),
    'A7b 117h 第 0 步的字段真的在行上（missionTitle / acceptanceItems）');

  const executable = browserPath();
  ok(Boolean(executable), 'A8 Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1440,1000',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A9 browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
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
  await cdp.evaluate('location.reload(); true');
  await waitForEval(cdp, READY);
  ok(Boolean(await waitForEval(cdp, 'Array.isArray(window.__ruyiLiveIntervals && window.__ruyiLiveIntervals()) ? 1 : null')),
    'A10 计时器探针已装上');

  // ── ① 进管家壳 → 一行状态 ─────────────────────────────────────────────────────
  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgShellMode');
    select.value = 'steward';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === 'steward'`);
  const expectedLine = fill('stewardShell.board.statusLine', { missions: 2, running: 1, needsYou: 1 });
  const entered = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.statusLine === ${JSON.stringify(expectedLine)} ? snapshot : null;
  })()`);
  ok(Boolean(entered), `B1 一行状态说「${expectedLine}」`);
  if (!entered) {
    const actual = await cdp.evaluate(BOARD);
    console.log('DEBUG statusLine=' + JSON.stringify(actual && actual.statusLine));
  }
  ok(entered && entered.boardHidden === true && entered.expanded === 'false',
    'B1b 看板默认收着（一行状态是它的开关）');

  // ── ⑤ 「现在这一件」：≥1000px 常驻，焦点是【等你】那条 ─────────────────────────
  // 抽屉先把骨架亮出来再补内容（openThread 同步渲染 + 异步 refreshOnce），所以标题要等它落定。
  const docked = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.nowHidden === false && snapshot.nowThread === ${JSON.stringify(THREAD_A)} ? snapshot : null;
  })()`) || await cdp.evaluate(BOARD);
  ok(docked && docked.nowHidden === false, 'B2 ≥1000px 时「现在这一件」常驻');
  ok(docked && docked.nowThread === THREAD_A,
    `B2b 焦点线程是【等你】那条（focusThreadFor：等你＞在跑＞失败＞最近；实测「${docked && docked.nowThread}」）`);
  ok(docked && docked.drawerMount === 'docked' && docked.drawerParent === 'stewardNowBody' && docked.drawerHidden === false,
    `B2c 它就是【同一个】抽屉节点被搬进 #stewardNowBody（实测 mount=${docked && docked.drawerMount} parent=${docked && docked.drawerParent}）`);
  // 117j W2-5：三个管家计时器统一按 5s 下限起表（真要不要拉由每一拍自己判），
  // 所以「这是管家的计时器」的身份判据从 POLL_MS 重钉到 TICK_MS —— 不改的话本断言恒真、形同虚设。
  ok(docked && docked.intervals.filter(ms => ms === TICK_MS).length === 2,
    `B2d 看板没打开时不多一条计时器（抽屉 + avatar 各一，实测 ${docked && JSON.stringify(docked.intervals)}）`);

  // ── ② 点开看板 → 分组、验收 a/b、等待原因、chip ────────────────────────────────
  await cdp.evaluate(`document.getElementById('stewardStatusLine').click(), true`);
  const opened = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.boardHidden === false && snapshot.groups.length ? snapshot : null;
  })()`);
  ok(Boolean(opened), 'C1 点一行状态即拉开看板');
  if (!opened) throw new Error('board did not open');
  ok(opened.boardRole === 'region' && opened.expanded === 'true', 'C1b 看板是 role="region"，一行状态 aria-expanded=true');
  ok(opened.groups.length === 2, `C2 按事项分成两组（实测 ${opened.groups.length}）`);
  const groupM = opened.groups.find(group => group.missionId === missionId) || null;
  const groupC = opened.groups.find(group => group.missionId === created.C) || null;
  ok(Boolean(groupM) && groupM.title === MISSION_TITLE,
    `C3 事项行显示【容器】标题（117h 第 0 步的 missionTitle；实测「${groupM && groupM.title}」）`);
  ok(Boolean(groupM) && groupM.pills.includes(fill('stewardShell.board.acceptance', { done: 1, total: 2 })),
    `C4 事项行显示验收 a/b（实测 ${groupM && JSON.stringify(groupM.pills)}）`);
  ok(Boolean(groupM) && groupM.pills.includes(fill('stewardShell.board.threadCount', { n: 2 })),
    'C4b 事项行显示线程数');
  ok(Boolean(groupC) && groupC.title === THREAD_C,
    `C5 自成事项的事项名回落成它自己的标题（实测「${groupC && groupC.title}」）`);
  ok(Boolean(groupM) && groupM.threads.length === 2 && groupC.threads.length === 1,
    'C6 线程行按事项归位（M 两条、C 一条）');
  const rowA = groupM && groupM.threads.find(thread => thread.sessionId === created.A);
  const rowB = groupM && groupM.threads.find(thread => thread.sessionId === created.B);
  ok(Boolean(rowA) && rowA.state === 'needs_you' && Boolean(rowB) && rowB.state === 'running',
    `C7 线程行五态经 mission-state.js（A=${rowA && rowA.state} / B=${rowB && rowB.state}）`);
  ok(Boolean(rowA) && rowA.wait.length > 0,
    `C8 等你那条给出等待原因（116h 的 wait.label 单点判定；实测「${rowA && rowA.wait}」）`);
  // 117q-B3b 重钉（理由同 30 号文 §4.4）：五态人话键从 stewardShell.drawer.state.* 搬到中性的
  // mission.state.*，看板／抽屉共用同一组键，locale 断言跟着改查新前缀。
  ok(Boolean(rowB) && rowB.wait === zh['mission.state.running'],
    `C8b 没在等的那条如实显示五态人话，不另编一句（实测「${rowB && rowB.wait}」）`);
  ok(Boolean(rowA) && JSON.stringify(rowA.chips) === JSON.stringify(['permission', 'model']),
    `C9 每行都有紧凑快切 chip：权限＋模型（引擎收进模型菜单；实测 ${rowA && JSON.stringify(rowA.chips)}）`);
  ok(Boolean(rowA) && ['prioritize', 'stop', 'open', 'classic'].every(action => rowA.actions.includes(action)),
    `C10 行操作齐备（优先／停止／打开／2.0；实测 ${rowA && JSON.stringify(rowA.actions)}）`);
  // 117l D4（用户第四轮走查①）：只加不改 —— 真在问你的那一行多一枚 pill，其它行没有。
  ok(Boolean(rowA) && JSON.stringify(rowA.asksYou) === JSON.stringify([zh['stewardShell.board.asksYou']]),
    `C10b 挂着 question 待决的那一行有「它在问你」pill（实测 ${rowA && JSON.stringify(rowA.asksYou)}）`);
  ok(Boolean(rowB) && rowB.asksYou.length === 0,
    `C10c 在跑（没人在问你）的那一行【没有】这枚 pill（实测 ${rowB && JSON.stringify(rowB.asksYou)}）`);
  await cdp.evaluate(`document.querySelector('#stewardBoardList .steward-board-thread[data-session-id="${created.A}"] .steward-board-pill.is-asks-you').click(), true`);
  ok(Boolean(await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.drawerHidden === false && snapshot.nowThread ? snapshot : null;
  })()`)), 'C10d 点这枚 pill 就是打开抽屉（问答框在那儿）');
  ok(opened.intervals.filter(ms => ms === TICK_MS).length === 3,
    `C11 看板打开才起第三条计时器（实测 ${JSON.stringify(opened.intervals)}）`);

  // ── 117l-B2 ②：看板视觉的可判定结果（用户第五轮走查 2）──────────────────────────
  const transparent = value => /rgba\(0, 0, 0, 0\)|transparent/.test(String(value));
  ok(opened.topGround && !transparent(opened.topGround.split('|')[0])
    && /^(none|)$/.test(opened.topGround.split('|')[1] || ''),
    `V1 顶部 toolbar 有自己的玻璃底，且【没有】叠 backdrop-filter（同屏模糊预算不变；实测 ${opened.topGround}）`);
  ok(opened.missionGround && !transparent(opened.missionGround.split('|')[0])
    && /^(none|)$/.test(opened.missionGround.split('|')[1] || ''),
    `V2 每个事项是一张有底的卡，同样不叠模糊（实测 ${opened.missionGround}）`);
  ok(opened.threadRule && /^0px\|1px\|16px$/.test(opened.threadRule),
    `V3 同一张卡里第一条线程行不画上边线、第二条画 1px 分隔线，两条都缩进 --sp-4=16px（实测 ${opened.threadRule}）`);
  ok(Array.isArray(opened.titleWidths) && opened.titleWidths.length >= 3 && opened.titleWidths.every(width => width > 0),
    `V4 每条线程行的名字都真的占着宽度（不会被 pill 与时间挤成 0；实测 ${JSON.stringify(opened.titleWidths)}）`);
  // 本夹具里 B 只有一个活的对话回合、没有可暂停的 run（pauseAll 自己也会说「那些只能停止」），
  // 所以「全部暂停」应当是灰的 —— 这正是「按钮说的话必须是真的」那条纪律的可判定形式。
  const pausableRows = rowsNow.filter(row => row.lastRun && row.lastRun.live === true && row.lastRun.paused !== true);
  ok(opened.pauseAllDisabled === (pausableRows.length === 0),
    `V5 「全部暂停」的可点态与「真有几条可暂停」一致（可暂停 ${pausableRows.length} 条，按钮 disabled=${opened.pauseAllDisabled}）`);

  // ── ③ 「同时最多」改成 3 → 后端即时生效 ──────────────────────────────────────
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardBoardMax');
    input.value = '3';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const arbiter = await waitForHttp(appPort, 'GET', '/api/steward/arbiter',
    result => result.json && result.json.maxParallel === 3, token);
  ok(Boolean(arbiter), 'D1 改「同时最多」为 3 → GET /api/steward/arbiter.maxParallel === 3（116h 即时生效）');
  ok(Boolean(await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.maxValue === '3' && snapshot.note === ${JSON.stringify(fill('stewardShell.board.maxParallelSaved', { n: 3 }))} ? snapshot : null;
  })()`)), 'D1b 界面回填的是后端真答应了的数');

  // ── ④ 「优先」：语义刻意做窄，不在队列里就如实说 ─────────────────────────────
  await cdp.evaluate(`document.querySelector('.steward-board-thread[data-session-id="${created.C}"] [data-action="prioritize"]').click(), true`);
  const prioritized = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.note && snapshot.note !== ${JSON.stringify(fill('stewardShell.board.maxParallelSaved', { n: 3 }))} ? snapshot : null;
  })()`);
  ok(prioritized && [zh['stewardShell.board.prioritized'], zh['stewardShell.board.notQueued']].includes(prioritized.note),
    `D2 点「优先」→ 后端回了稳定信封，界面照说（实测「${prioritized && prioritized.note}」）`);

  // ── ⑥ 显式选线程覆盖自动挑选 ─────────────────────────────────────────────────
  await cdp.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: '${created.C}' } })), true`);
  const switched = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.nowThread === ${JSON.stringify(THREAD_C)} ? snapshot : null;
  })()`);
  ok(Boolean(switched), 'E1 派发 steward:focus-thread 把「现在这一件」切到另一条（钉住，不再被自动挑选换走）');

  // ── ⑦ 「关掉」→ 回单列并记住；行上的「打开」把它请回来 ────────────────────────
  await cdp.evaluate(`document.getElementById('stewardNowCloseBtn').click(), true`);
  const closed = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.nowHidden === true ? snapshot : null;
  })()`);
  ok(Boolean(closed), 'F1 「关掉」→ 回单列');
  ok(closed && closed.nowClosedPref === '1', `F1b 本机偏好记住了（localStorage wcw.stewardNowClosed=${closed && closed.nowClosedPref}）`);
  ok(closed && closed.drawerHidden === true && closed.drawerParent === 'stewardShell',
    'F1c 抽屉节点搬回管家壳并收起（不是留在右栏里空着）');
  await cdp.evaluate(`document.getElementById('stewardStatusLine').click(), true`);
  await waitForEval(cdp, `(() => { const s = ${BOARD}; return s.boardHidden === false ? 1 : null; })()`);
  await cdp.evaluate(`document.querySelector('.steward-board-thread[data-session-id="${created.A}"] [data-action="open"]').click(), true`);
  const reopened = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.nowHidden === false && snapshot.nowThread === ${JSON.stringify(THREAD_A)} ? snapshot : null;
  })()`);
  ok(Boolean(reopened), 'F2 行上的「打开」把「现在这一件」请回来（关掉不是单程票）');
  ok(reopened && reopened.nowClosedPref === '' && reopened.boardHidden === true,
    'F2b 请回来时清掉「关掉」偏好，并把看板收起（别盖着自己要看的东西）');

  // ── ⑥b 117r-D2（用户第八轮走查①「管家新开线程之后不会自动打开线程详情页了」）──────────
  // 造的是真正出问题的那个时序：线程在看板【已经取过一趟行之后】才建出来，所以它一定不在手里
  // 这批 rows 里（rows 是上一趟 GET /api/missions 的快照）。此刻看板是关着的（F2b 刚断言过），
  // syncPolling 的门控因此把表也停了 —— 除了「焦点事件那一刷」没有任何东西会去刷新行。
  const madeD = await request(appPort, 'POST', '/api/sessions', { title: THREAD_D, cwd: home }, token);
  const idD = (madeD && madeD.json && madeD.json.session && madeD.json.session.id) || '';
  if (idD) {
    await request(appPort, 'POST', '/api/mission', {
      sessionId: idD, action: 'start', goal: THREAD_D, milestones: [{ id: 'm1', desc: '第一步' }],
    }, token);
  }
  ok(Boolean(idD), `E2 第四条线程在浏览器取过行之后才建出来（${idD || '失败'}）`);
  const projected = await request(appPort, 'GET', '/api/missions?limit=200', null, token);
  ok(((projected && projected.json && projected.json.missions) || []).some(row => row.sessionId === idD),
    'E2a 服务端投影里确实有它 —— 看板此刻取不到它的唯一原因是【行还没刷】');
  const boardIdsOf = snapshot => (snapshot && Array.isArray(snapshot.groups) ? snapshot.groups : [])
    .flatMap(group => group.threads.map(thread => thread.sessionId));
  const beforeFocus = await cdp.evaluate(BOARD);
  ok(!boardIdsOf(beforeFocus).includes(idD),
    `E2b 派事件之前，看板手里的行【没有】这一条（实测 ${JSON.stringify(boardIdsOf(beforeFocus))}）`);
  // 记下抽屉标题的变化轨迹：修前看板会把抽屉刚打开的那一份顶掉、换成自动挑选的【等你】那条
  // （THREAD_A），所以「中途有没有回落」是可判定的 —— 只看最终态不够（那一刷最终仍会纠回来）。
  await cdp.evaluate(`(() => {
    const node = document.getElementById('stewardDrawerTitle');
    window.__ruyiTitleTrail = [];
    new MutationObserver(() => {
      const text = node.textContent.trim();
      const trail = window.__ruyiTitleTrail;
      if (!trail.length || trail[trail.length - 1] !== text) trail.push(text);
    }).observe(node, { childList: true, characterData: true, subtree: true });
    return true;
  })()`);
  await cdp.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: '${idD}' } })), true`);
  const focusedNew = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.nowHidden === false && snapshot.nowThread === ${JSON.stringify(THREAD_D)} ? snapshot : null;
  })()`);
  ok(Boolean(focusedNew),
    `E2c 行里还没有它，右栏照样把这条【刚建出来的】线程打开（实测「${focusedNew && focusedNew.nowThread}」）`);
  const titleTrail = await cdp.evaluate('window.__ruyiTitleTrail || []');
  ok(Array.isArray(titleTrail) && !titleTrail.includes(THREAD_A),
    `E2d 中途【没有】回落到自动挑选的那条（修前 currentFocusId 不认这一钉，会把抽屉顶成「${THREAD_A}」；实测轨迹 ${JSON.stringify(titleTrail)}）`);
  ok(boardIdsOf(focusedNew).includes(idD),
    'E2e 焦点事件同时触发了那一刷：这一钉随后被真行核实（文件头刷新纪律的「焦点事件」这一刷）');
  // 边界必须是【有界的】：不许「一钉就永久信任」—— 一条根本不存在的线程会把右栏永远占着。
  // 派一条不存在的 id：那一刷跑完就交回原判据，右栏回到自动挑选的【等你】那条。
  await cdp.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: 'sess_117r_d2_absent' } })), true`);
  const bounded = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.nowThread === ${JSON.stringify(THREAD_A)} ? snapshot : null;
  })()`);
  ok(Boolean(bounded) && bounded.nowHidden === false,
    `E2f 一条【不存在】的线程只被信任到那一刷跑完为止，随后交回原判据、回落自动挑选（实测「${bounded && bounded.nowThread}」）`);

  // ── R 117s-B（用户第九轮走查①「递话给已有线程也不会自动打开线程详情页」／④「给已收工的
  // 线程重新递话，『它刚说』更新不够及时」）────────────────────────────────────────────────
  // 与上面 E2 那一组【互补】：E2 造的是「行里还没有它」（管家刚开的新线程），这一组造的是另一半 ——
  // 抽屉【已经开着的就是这一条】。
  //
  // 27 号文 §11.13 把 ① ④ 的根因写成「syncNow() 相等时什么都不做，抽屉于是原样不动」——
  // 这句话【只对了一半】：抽屉自己也听 steward:focus-thread（steward-drawer.js 的 bindStewardDrawer），
  // 收到就无条件 openThread(id) 重读一遍，同一个 id 也照读。所以真正会让用户看到旧内容的是另外
  // 两个口子，本组各钉一条：
  //   ㈠【强刷读得太早】：递话刚落地时那个回合往往还没活过来（排队／抢工作区写锁），强刷这一趟
  //      读到的还是「已收工」；而强刷跑完把 lastPollAt 记成当下，等于把下一次复核推到一整个空闲
  //      节拍之后（config.stewardPollMs，本夹具 120000ms，用户真机 15000ms）。→ R4。
  //   ㈡【没有事件的那条焦点路】：看板行上的「打开」与行标题走的是本模块的 focusThread()，
  //      【不派事件】，抽屉那边一无所知 —— 右栏已经开着这条线程时，修前这一路一次都不刷。→ R8。
  // 两条线程：E 钉㈠，F 钉㈡。都走【无账本】那一路（不开 /api/mission 账本 → 卡片 status='none'），
  // 因为只有它的五态会从「已收工」翻成「进行中」：有账本且里程碑全 done 的线程 result=complete，
  // 按 mission-state.js 的判定顺序 done 排在 running【前面】，再跑一个回合仍然显示「已收工」
  // （那是另一件事，不在本刀）。无账本线程要进 GET /api/missions 得先被管家「看着」
  // （06i stewardWatchedThread）—— 挂进事项容器 M 就够了（missionId !== sessionId 那一支，117r-D1 立的判据）。
  const settleThread = async (title, cwd) => {
    const made = await request(appPort, 'POST', '/api/sessions', { title, cwd }, token);
    const id = (made && made.json && made.json.session && made.json.session.id) || '';
    if (!id) return '';
    await request(appPort, 'POST', `/api/missions/${encodeURIComponent(missionId)}/threads`, { action: 'attach', sessionId: id }, token);
    await request(appPort, 'POST', '/api/chat/stream', { sessionId: id, message: '收个尾', cwd }, token);
    const settled = await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
      const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === id);
      return Boolean(row) && row.activeTurn !== true && row.status === 'none' && Number(row.turnSeq) > 0;
    }, token);
    return settled ? id : '';
  };
  const idE = await settleThread(THREAD_E, workE);
  const idF = await settleThread(THREAD_F, workF);
  ok(Boolean(idE) && Boolean(idF),
    `R1 两条【无账本、已跑完一个回合】的线程就位（status=none ＋ turnSeq>0 ＋ 此刻没在跑 → 五态就是「${zh['mission.state.done']}」；${idE || '失败'} / ${idF || '失败'}）`);
  const liveOn = async id => waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === id);
    return Boolean(row && row.activeTurn === true);
  }, token);
  // 抽屉快照的等待循环：返回【等到没等到】与实测耗时，好让断言把「几秒内」写成可判定的数。
  const waitForDrawer = async (title, state, head, needle, budgetMs) => {
    const startedAt = Date.now();
    for (let i = 0; Date.now() - startedAt < budgetMs; i++) {
      const snapshot = await cdp.evaluate(BOARD).catch(() => null);
      if (snapshot && snapshot.nowThread === title && snapshot.nowState === state
        && snapshot.nowLastSayHead === head && String(snapshot.nowLastSay || '').includes(needle)) {
        return { snapshot, ms: Date.now() - startedAt };
      }
      await sleep(100);
    }
    return { snapshot: null, ms: Date.now() - startedAt };
  };

  // ── ㈠ 强刷读得太早：下一拍必须真的去复核，而不是被推后一整个空闲节拍 ──────────────────
  // 先把抽屉关掉再从行上「打开」重开 —— closeDrawer 会 stopPolling、openThread 再 startPolling，
  // 于是轮询表的【相位从这一刻重新起算】：下一拍稳稳落在 5 s 之后，中间有足够的余量把回合起起来。
  // 这不是为了好测才走的路，F1／F2 两条既有断言走的就是这条真实交互（× 关掉 → 行上「打开」请回来）。
  await cdp.evaluate(`document.getElementById('stewardNowCloseBtn').click(), true`);
  await waitForEval(cdp, `(() => { const s = ${BOARD}; return s.nowHidden === true ? 1 : null; })()`);
  await cdp.evaluate(`document.getElementById('stewardStatusLine').click(), true`);
  await waitForEval(cdp, `(() => { const s = ${BOARD}; return s.boardHidden === false ? 1 : null; })()`);
  // 看板刚拉开时正文还是上一趟的行；先等这一条线程的行真的渲染出来再点（不然 querySelector 拿到 null）。
  await waitForEval(cdp, `!!document.querySelector('.steward-board-thread[data-session-id="${idE}"] [data-action="open"]')`);
  await cdp.evaluate(`document.querySelector('.steward-board-thread[data-session-id="${idE}"] [data-action="open"]').click(), true`);
  await sleep(1500);
  const settledE = await cdp.evaluate(BOARD);
  ok(settledE && settledE.nowThread === THREAD_E && settledE.nowState === zh['mission.state.done']
    && settledE.nowLastSayHead === zh['stewardShell.drawer.lastSay'],
    `R2 右栏重新开在线程 E 上：状态行「${zh['mission.state.done']}」、标题「${zh['stewardShell.drawer.lastSay']}」——这就是递话进来【之前】的那一帧（实测 state=「${settledE && settledE.nowState}」head=「${settledE && settledE.nowLastSayHead}」）`);
  // 递话的服务端那一半：给这条已收工的线程重新开一个回合（provider 的 hang 支只开流不收尾，
  // 于是 activeTurn 一直为真、服务端的 liveTail 里有「开工了…」）。这一刻【在强刷之后】——
  // 正是真机上「递话刚落地、回合还在排队」时强刷读到的那个时序。
  request(appPort, 'POST', '/api/chat/stream', { sessionId: idE, message: 'hang here', cwd: workE }, token);
  ok(Boolean(await liveOn(idE)), 'R3 线程 E 的新回合真的在飞（服务端投影 activeTurn=true）—— 递话的服务端那一半已经发生，且它发生在抽屉那一次强刷【之后】');
  const flippedE = await waitForDrawer(THREAD_E, zh['mission.state.running'], zh['stewardShell.drawer.liveSay'], '开工了', 30000);
  ok(Boolean(flippedE.snapshot) && flippedE.ms <= 12000,
    `R4 强刷读到的还是「已收工」时，【下一拍】（5 s 下限那一档）真的去复核了：状态行变「${zh['mission.state.running']}」、标题变「${zh['stewardShell.drawer.liveSay']}」（实测 ${flippedE.ms}ms；修前强刷把 lastPollAt 记成当下，下一次复核要等一整个空闲节拍 ${POLL_MS}ms）`);
  ok(Boolean(flippedE.snapshot) && flippedE.snapshot.nowState === zh['mission.state.running'],
    `R4b 同一拍里【状态行】也纠了过来：五态只有事项面知道，那一拍必须把事项切片一起重拉（live 假→真与既有的真→假对称；实测「${flippedE.snapshot && flippedE.snapshot.nowState}」）`);

  // ── ㈡ 看板行上的「打开」是一条【不派事件】的焦点路 ────────────────────────────────────
  // 抽屉那边听不到任何东西 —— 右栏已经开着这条线程时，修前这一路一次都不刷。
  await cdp.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: '${idF}' } })), true`);
  const onF = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.nowHidden === false && snapshot.nowThread === ${JSON.stringify(THREAD_F)}
      && snapshot.nowState === ${JSON.stringify(zh['mission.state.done'])}
      && snapshot.nowLastSayHead === ${JSON.stringify(zh['stewardShell.drawer.lastSay'])} ? snapshot : null;
  })()`);
  ok(Boolean(onF), `R5 右栏开在线程 F 上，且是「${zh['mission.state.done']}」那一帧（实测 state=「${onF && onF.nowState}」）`);
  // openThread 末尾那次强刷把节拍闸清零，于是随后【多一拍】—— 先把那一拍等掉（表的周期是 5 s），
  // 下面 R7 测到的才是真的空闲节拍，不是这一拍。
  await sleep(6000);
  request(appPort, 'POST', '/api/chat/stream', { sessionId: idF, message: 'hang here', cwd: workF }, token);
  ok(Boolean(await liveOn(idF)), 'R6 线程 F 的新回合也在飞了（服务端投影 activeTurn=true）');
  await sleep(1500);
  const staleF = await cdp.evaluate(BOARD);
  ok(staleF && staleF.nowState === zh['mission.state.done'] && staleF.nowLastSayHead === zh['stewardShell.drawer.lastSay'],
    `R7 没有任何刷新的话抽屉自己【发现不了】：空闲线程走 config.stewardPollMs（本夹具 ${POLL_MS}ms，用户真机 15000ms），屏幕上还是「${zh['mission.state.done']}」＋「${zh['stewardShell.drawer.lastSay']}」（实测 state=「${staleF && staleF.nowState}」head=「${staleF && staleF.nowLastSayHead}」）`);
  await cdp.evaluate(`document.getElementById('stewardStatusLine').click(), true`);
  await waitForEval(cdp, `(() => { const s = ${BOARD}; return s.boardHidden === false ? 1 : null; })()`);
  await waitForEval(cdp, `!!document.querySelector('.steward-board-thread[data-session-id="${idF}"] [data-action="open"]')`);
  const clickedAt = Date.now();
  await cdp.evaluate(`document.querySelector('.steward-board-thread[data-session-id="${idF}"] [data-action="open"]').click(), true`);
  const flippedF = await waitForDrawer(THREAD_F, zh['mission.state.running'], zh['stewardShell.drawer.liveSay'], '开工了', 30000);
  ok(Boolean(flippedF.snapshot) && Date.now() - clickedAt <= 5000,
    `R8 对【右栏已经开着的那条线程】再点一次行上的「打开」→ 5 s 内状态行由「${zh['mission.state.done']}」变「${zh['mission.state.running']}」、「${zh['stewardShell.drawer.lastSay']}」换成「${zh['stewardShell.drawer.liveSay']}」（实测 ${Date.now() - clickedAt}ms；这一路不派事件，修前 syncNow 相等即跳过，抽屉一次都不刷）`);
  ok(Boolean(flippedF.snapshot) && flippedF.snapshot.nowLastSay.includes('开工了'),
    `R8b 换上来的是【新那一回合】流出来的话，不是上一回合的落盘原话（实测「${flippedF.snapshot && flippedF.snapshot.nowLastSay}」）`);

  // ── ⑧ 缩到 900px → 不常驻 ────────────────────────────────────────────────────
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });
  const narrow = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.nowHidden === true ? snapshot : null;
  })()`);
  ok(Boolean(narrow), 'G1 缩到 900px → 「现在这一件」不常驻（抽屉退回覆盖式）');
  ok(narrow && narrow.nowClosedPref === '', 'G1b 因为窄而收起不算用户「关掉」，本机偏好不被写脏');
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  // ── ⑨ 切回经典壳：零残留定时器 ───────────────────────────────────────────────
  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgShellMode');
    select.value = 'classic';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const classic = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return document.documentElement.getAttribute('data-shell-mode') === 'classic' ? snapshot : null;
  })()`);
  ok(Boolean(classic) && classic.intervals.filter(ms => ms === TICK_MS).length === 0,
    `H1 切回经典壳后管家侧零残留定时器（实测 ${classic && JSON.stringify(classic.intervals)}）`);
  ok(Boolean(classic) && classic.boardHidden === true && classic.nowHidden === true,
    'H2 看板与「现在这一件」都收起');
} catch (error) {
  console.log('ERROR ' + (error && error.stack || error));
  fail += 1;
} finally {
  if (cdp && fail) console.log('CONSOLE ' + cdp.logs.slice(-6).join(' | '));
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  for (const socket of openSockets) { try { socket.end(); } catch { /* already closed */ } }
  if (provider) await new Promise(resolve => provider.close(resolve));
  await sleep(300);
  stopRuyiTestBrowsers(profile);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* browser profile lock */ }
  console.log(`\nSTEWARD BOARD E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
