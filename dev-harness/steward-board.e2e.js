#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）

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
// 124 还债①：那件「收工了却没人记过验收」的活与它那条无账本线程。
const EMPTY_MISSION_TITLE = '没人记过验收的那件';
const THREAD_UNREC = '它底下那条';
const THREAD_C = '选个框架';
// 117r-D2：这一条【故意】等浏览器已经取过一趟行之后才建，专用来造「行还没刷到就派焦点事件」的时序。
const THREAD_D = '刚开的这一条';
// 117s-B：抽屉【已经开着的就是这一条】时递话进来的两条线程（都走无账本那一路，见 R 组的头注）。
// E 钉「强刷读得太早」那一条，F 钉「看板行上的『打开』不派事件」那一条。
const THREAD_E = '收工了又被叫醒';
const THREAD_F = '收工了又被点开';
// 治抖动那批（34 号文 §13.6 登记①）：R8 原来钉的是【行上「打开」这一路自己也得刷】，但它跟在
// R7（推送已经把状态翻过来了）后面，点开的时候早就翻好了——断言写的时候以为在守门，其实门是
// 画上去的（推送先到，click 自己的强刷从没被真正考过）。这一条【断连之后】专用，证的是同一件事
// 在推送死了之后是否仍然成立。
const THREAD_F2 = '断连时收工又被点开';
// F3（S 组）：右栏「现在这几件」要同时看到三种状态，这一条专门停在「已收工」不再被叫醒。
const THREAD_G = '这件已经收工了';
// F3（S 组）：等你的那条与在跑的那条也就地造，不借早先那两条（跑到 S 组时它们可能已经收尾）。
const THREAD_H = '这件在等你答';
const THREAD_I = '这件正在跑着';
const POLL_MS = 120000;   // 配置的节拍拉满：测试窗口内不会真的去拉，计时器只按周期数个数
// 117j W2-5：表按 5s 下限起（见 steward-board.js pollTick 头注），数计时器要按这个周期。
const TICK_MS = 5000;

const { findBrowserExecutable } = require('./lib/browser-path');
const browserPath = findBrowserExecutable;

// 121-K4 修夹具（不是修产品）：`timeoutMs` 是新加的第六个参数，默认仍是 20 s。
// 病根：本件那几发「不 await 的回合」（provider 的 ask／hang 两支刻意不收尾，好让 A 停在等你、
// B 一直在跑）走的就是这个 helper —— 20 s 一到 req.destroy()，服务端那一头的流断掉，回合随之
// 结束。夹具在浏览器冷启动快的机器上刚好赶得及（K4-1 那一轮 97 条全绿），慢一点就整组塌方：
// B1 读到「0 条在跑，0 条等你」，随后每一条都跟着红（实测三轮：A=stopped／B=stopped、
// asksYou 为空、wait 为空 —— 全是同一个根）。这不是产品的行为，是夹具自己把回合掐了。
// 所以：要它【活着】的那几发给 10 分钟，其余一律照旧 20 s。
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
  // 121-K4-4:就绪判据里那个 #stewardBoard 随看板浮层一起退役了(K4-2 删的),门因此永远合不上
  // —— waitForEval 白等满 32 s 再往下走(功能全绿,只是每跑一趟多烧半分钟)。换成左栏的行容器
  // #railList:它是这一件从头到尾要看的那个东西。
  if (!document.getElementById('railList') || !window.state || !window.state.status || !window.state.config) return null;
  return { ready: true };
})()`;

// 看板快照：全部走 textContent / 属性，不碰任何模块私有状态。
const BOARD = `(() => {
  const text = id => { const node = document.getElementById(id); return node ? node.textContent.trim() : ''; };
  const now = document.getElementById('stewardSide');   // 121-K4：浮层「现在这几件」→ 栅格里常驻的右栏
  const drawer = document.getElementById('stewardDrawer');
  const line = document.getElementById('stewardStatusLine');
  // 121-K4-2：看板浮层退役，行搬到左栏 #railList，并且【按任务】归组：
  //   · 单线程任务 = .rail-tasks 的直系 li.steward-board-thread（不画任务层）；
  //   · 多线程任务 = 一行 li.rail-task ＋ 紧跟的 .rail-threads（展开容器）里的那几条线程行。
  // 探针把两种形状折成【同一个 groups 形状】，于是下面那几十条断言钉的仍是同一件事
  // （哪一件有几条线程、验收印几次、行上有什么）—— 变的只是它们长在哪个容器里。
  const railGroups = () => {
    const out = [];
    for (const section of document.querySelectorAll('#railList .rail-group')) {
      for (const node of section.querySelector('.rail-tasks').children) {
        if (node.classList.contains('rail-task')) {
          const wrap = node.nextElementSibling;
          out.push({ head: node, rows: wrap ? [...wrap.querySelectorAll('.steward-board-thread')] : [], group: section.dataset.group || '' });
        } else if (node.classList.contains('steward-board-thread')) {
          out.push({ head: null, rows: [node], group: section.dataset.group || '' });
        }
      }
    }
    return out;
  };
  const readRow = item => ({
    sessionId: item.dataset.sessionId || '',
    title: (item.querySelector('.steward-board-thread-title') || {}).textContent || '',
    state: item.dataset.state || '',
    statePillText: (item.querySelector('.steward-board-thread-head .steward-board-pill[data-state]') || { textContent: '' }).textContent.trim(),
    hue: item.dataset.threadHue || '',
    bars: item.querySelectorAll('.steward-tcard-bar').length,
    stateDots: item.querySelectorAll('.steward-board-dot').length,
    hueDots: item.querySelectorAll('.steward-tcard-dot').length,
    wait: (item.querySelector('.steward-board-wait') || {}).textContent || '',
    sub: (item.querySelector('.steward-board-sub') || { textContent: '' }).textContent.trim(),
    origin: (item.querySelector('.rail-origin') || {}).dataset ? item.querySelector('.rail-origin').dataset.origin : '',
    quick: [...item.querySelectorAll('.steward-board-pill')].some(node => node.dataset.kind === 'quick_ask'),
    asksYou: [...item.querySelectorAll('.steward-board-pill.is-asks-you')].map(node => node.textContent.trim()),
    chips: [...item.querySelectorAll('.steward-board-chips .steward-chip')].map(node => node.dataset.chip),
    actions: [...item.querySelectorAll('.steward-board-actions .steward-board-btn')].map(node => node.dataset.action),
    newThreadInTail: item.querySelectorAll('.steward-board-actions [data-new-thread]').length,
    headMeta: [...item.querySelectorAll('.steward-board-thread-head .steward-board-meta')].map(node => node.textContent.trim()),
  });
  return {
    statusLine: line ? line.textContent.trim() : '',
    expanded: line ? line.getAttribute('aria-expanded') : '',
    railCount: (document.getElementById('railCount') || {}).textContent || '',
    railGroupNames: [...document.querySelectorAll('#railList .rail-group')].map(node => node.dataset.group),
    plusLabel: (document.getElementById('newSessionBtnLabel') || {}).textContent || '',
    chip: (() => {
      const node = document.getElementById('appStatusChip');
      return node ? { hidden: node.hidden, text: node.textContent.trim() } : null;
    })(),
    maxValue: (document.getElementById('stewardBoardMax') || {}).value || '',
    running: text('stewardBoardRunning'),
    queued: text('stewardBoardQueued'),
    note: text('stewardBoardNote'),
    groups: railGroups().map(entry => ({
      missionId: (entry.head ? entry.head.dataset.missionId : '')
        || (entry.rows[0] ? entry.rows[0].dataset.sessionId : ''),
      // 121-K4：B1 的口径反过来了 —— 单线程任务【不画任务层】（那一行就是它的线程行），
      // ≥2 条才有任务行。所以 grouped/hasHead 这两个字段的意思一个字没变，只是判据换成
      // 「有没有那一行 .rail-task」。
      grouped: Boolean(entry.head),
      hasHead: Boolean(entry.head),
      title: entry.head ? (entry.head.querySelector('.steward-board-thread-title') || {}).textContent || '' : '',
      text: (entry.head ? entry.head.textContent : '') + entry.rows.map(row => row.textContent).join(''),
      pills: entry.head ? [...entry.head.querySelectorAll('.steward-board-thread-head .steward-board-pill')].map(node => node.textContent.trim()) : [],
      group: entry.group,
      open: entry.head ? entry.head.classList.contains('is-open') : null,
      taskCount: entry.head ? (entry.head.querySelector('.rail-task-count') || {}).textContent || '' : '',
      // 验收 a/b 仍然整件事只印一次：多线程印在任务行的卡尾，单线程印在那唯一一张卡的卡尾。
      facts: [(entry.head ? [...entry.head.querySelectorAll('.steward-board-facts')] : [])
        .concat(entry.rows.flatMap(row => [...row.querySelectorAll('.steward-board-facts')]))]
        .flat().map(node => node.textContent.trim()),
      threads: entry.rows.map(readRow),
    })),
    // 121-K4：「＋ 线程」在任务行上是【唯一】一枚动作（线程级的那几枚在线程行上），
    // 所以这里数的是「任务行的卡头里有没有它」——卡头上仍然一枚常亮按钮都不许有。
    missionHeadNewThread: document.querySelectorAll('#railList .rail-task .steward-board-thread-head [data-new-thread]').length,
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
      const top = document.querySelector('#sidebar .rail-board-head');
      if (!top) return '';
      const style = getComputedStyle(top);
      return style.backgroundColor + '|' + style.backdropFilter + '|' + style.display;
    })(),
    // 同一个任务下第二条线程行的上边线（分隔线）与整行的左缩进（121-K4：缩进改由 padding 给，
    // 因为展开容器是 grid 0fr→1fr，外边距会在收起那一帧被算进去、露出一条缝）。
    threadRule: (() => {
      const rows = [...document.querySelectorAll('#railList .rail-threads')]
        .map(wrap => [...wrap.querySelectorAll('.steward-board-thread')])
        .find(list => list.length >= 2) || [];
      if (rows.length < 2) return '';
      const first = getComputedStyle(rows[0]);
      const second = getComputedStyle(rows[1]);
      return first.borderTopWidth + '|' + second.borderTopWidth + '|' + second.paddingInlineStart;
    })(),
    // 线程名在窄屏下有没有被挤没（走查 2 的返工点：0 宽 = 名字从屏幕上消失）。
    titleWidths: [...document.querySelectorAll('#railList .steward-board-thread-title')]
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
const workUnrec = path.join(root, 'work-unrec');   // 124 还债①：那条无账本线程自己的目录（避开 116h 的同 cwd 写互斥）
// 117s-B：线程 E 自己的工作文件夹 —— 它要连跑两个回合（一个收尾、一个挂着），
// 与 A／B 同 cwd 会撞上 116h 的写互斥，那不是本组要测的形状。
const workE = path.join(root, 'work-e');
const workF = path.join(root, 'work-f');
const workF2 = path.join(root, 'work-f2');
const profile = path.join(root, 'profile');
for (const dir of [home, workA, workB, workUnrec, workE, workF, workF2]) fs.mkdirSync(dir, { recursive: true });
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

  // ── 124 还债①（40 号文 §8.5 ①；用户 2026-09-15 拍板「只在收工了却没人记过时印」）──────
  // 造一件**收工了却没人记过验收**的活：事项容器【不带任何验收项】，底下挂一条【没有账本】的线程
  // （只 POST /api/sessions，不 POST /api/mission start，所以头上没有 mission 容器），也没跑过回合
  // → 聚合态落收工档。这正是 41 号方案 §9 J08 要挡的那一格：收工了，却没有任何验收记录。
  // 上面 A／B／C 三条都 `mission start` 过、都带账本，所以碰不到这一支 —— 这一刀之前，
  // 这个形状在整套夹具里一次都没出现过。
  const emptyContainer = await request(appPort, 'POST', '/api/missions', { title: EMPTY_MISSION_TITLE }, token);
  const emptyMissionId = emptyContainer && emptyContainer.json && emptyContainer.json.mission && emptyContainer.json.mission.missionId;
  const threadD = await request(appPort, 'POST', '/api/sessions', { title: THREAD_UNREC, cwd: workUnrec }, token);
  const createdD = threadD && threadD.json && threadD.json.session && threadD.json.session.id;
  ok(Boolean(emptyMissionId && createdD), `A4c 空验收事项与它那条无账本线程已建（${emptyMissionId || '失败'} / ${createdD || '失败'}）`);
  const attachD = await request(appPort, 'POST', `/api/missions/${encodeURIComponent(emptyMissionId)}/threads`, { action: 'attach', sessionId: createdD }, token);
  ok(Boolean(attachD && attachD.json && attachD.json.ok === true), `A4d 那条无账本线程挂进了空验收事项（实测 ${attachD && attachD.status} ${JSON.stringify(attachD && attachD.json)}）`);

  // 117u-G2 B3（27 号文 §11.15.3「事实降级」）：把线程 C 的权限档【钉成会话级】，A／B 留着
  // 跟随全局 —— 于是「与全局不同才印那两枚 chip」这条判据在同一屏里两侧都验得到（只验一侧的话，
  // 把判据写成恒假也能绿）。走的是 chips 自己那条唯一写口（PATCH /api/sessions/:id），
  // 不直接改盘上的会话头。
  const pinnedPermission = await request(appPort, 'PATCH', `/api/sessions/${encodeURIComponent(created.C)}`,
    { permissionMode: 'plan' }, token);
  ok(Boolean(pinnedPermission && pinnedPermission.json && pinnedPermission.json.ok === true
    && pinnedPermission.json.session && pinnedPermission.json.session.permissionMode === 'plan'),
    `A4b 线程 C 定了会话级权限档（B3 的「与全局不同」那一侧；实测 ${pinnedPermission && pinnedPermission.json && pinnedPermission.json.session && pinnedPermission.json.session.permissionMode}）`);

  // A：停在 question 待决（等你）。B：回合一直挂着（在跑）。两条各自的工作文件夹不同 ——
  // 116h 的同 cwd 写互斥会把后来的那条压成「等锁」，那不是本件要测的形状。
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.A, message: 'ask about south', cwd: workA }, token, 600000);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return pending.some(item => item && item.type === 'question' && item.sessionId === created.A);
  }, token)), 'A5 线程 A 停在 question 待决（等你）');
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.B, message: 'hang here', cwd: workB }, token, 600000);
  const running = await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === created.B);
    return Boolean(row && row.activeTurn === true);
  }, token);
  ok(Boolean(running), 'A6 线程 B 的回合一直在飞（在跑）');

  const rowsNow = (await request(appPort, 'GET', '/api/missions?limit=200', null, token)).json.missions || [];
  // 124 还债①：多了线程 D（挂在空验收事项下的无账本线程），行数 3 → 4。
  // 124 还债①：那条无账本线程要真的【收工】—— 没跑过回合的线程是「交办中」（dispatching），
  // 而用户拍板的口径是【只在收工了却没人记过时】才印。跑一个普通回合到完（fake provider
  // 只有 ask/hang 两个剧本会停住，其余直接答完），它就落到收工档。
  await request(appPort, 'POST', '/api/chat/stream', { sessionId: createdD, message: 'wrap up', cwd: workUnrec }, token, 600000);
  const settledD = await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === createdD);
    return Boolean(row && (row.aggregateState === 'done' || row.aggregateState === 'stopped'));
  }, token);
  ok(Boolean(settledD), `A7c 那条无账本线程跑到了收工档（实测 ${Boolean(settledD)}）`);
  ok(rowsNow.length === 4 && rowsNow.filter(row => row.missionId === missionId).length === 2,
    `A7 四条线程都进了投影，其中两条挂在同一个事项下（实测 ${rowsNow.length} 行）`);
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
  // 治抖动那批（§13.6 登记①）：R8 要造一段真正的【事件流断连态】——Network 域留到那里才用
  // （只挡 /api/events/stream 这一条路由 + 一次短暂离线把已经建立的那条连接真正打断），
  // 别的请求（/api/missions、/api/sessions……）照走。
  await cdp.send('Network.enable');
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
  // 124 还债①：多了「没人记过验收的那件」（空验收容器 ＋ 一条无账本线程），任务数 2 → 3。
  // 在跑／等你那两个数不动 —— 新那一件既没跑回合也没待决，它落的就是收工档。
  const expectedLine = fill('stewardShell.board.statusLine', { missions: 3, running: 1, needsYou: 1 });
  const entered = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.statusLine === ${JSON.stringify(expectedLine)} ? snapshot : null;
  })()`);
  ok(Boolean(entered), `B1 一行状态说「${expectedLine}」`);
  if (!entered) {
    const actual = await cdp.evaluate(BOARD);
    console.log('DEBUG statusLine=' + JSON.stringify(actual && actual.statusLine));
  }
  // 121-K4-2：左栏【常开】—— 没有「默认收着、点开才有」这回事了（那正是 32 号文 §5 记的那笔债：
  // 看板一关，行就停在关上的那一帧）。B1b 因此翻面：进壳那一刻行就在屏幕上，且一行状态不再是开关。
  ok(entered && entered.expanded === null && entered.groups.length > 0,
    `B1b 左栏常开：进壳那一刻任务索引就在屏幕上（${entered && entered.groups.length} 件），一行状态不再是开关（无 aria-expanded）`);

  // ── ⑤ 「现在这一件」：≥1000px 常驻，焦点是【等你】那条 ─────────────────────────
  // 抽屉先把骨架亮出来再补内容（openThread 同步渲染 + 异步 refreshOnce），所以标题要等它落定。
  const docked = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.nowHidden === false && snapshot.nowThread === ${JSON.stringify(THREAD_A)} ? snapshot : null;
  })()`) || await cdp.evaluate(BOARD);
  ok(docked && docked.nowHidden === false, 'B2 ≥1000px 时管家视角的右栏常驻（121-K4：它是栅格里的一列，不再是 fixed 浮层）');
  ok(docked && docked.nowThread === THREAD_A,
    `B2b 焦点线程是【等你】那条（focusThreadFor：等你＞在跑＞失败＞最近；实测「${docked && docked.nowThread}」）`);
  ok(docked && docked.drawerMount === 'docked' && docked.drawerParent === 'stewardFocus' && docked.drawerHidden === false,
    `B2c 它就是【同一个】抽屉节点被搬进 #stewardFocus（实测 mount=${docked && docked.drawerMount} parent=${docked && docked.drawerParent}）`);
  // 117j W2-5：三个管家计时器统一按 5s 下限起表（真要不要拉由每一拍自己判），
  // 所以「这是管家的计时器」的身份判据从 POLL_MS 重钉到 TICK_MS —— 不改的话本断言恒真、形同虚设。
  // 121-K2b（34 号文 §6.2）重钉：「看板关着不刷」那道门删掉之后，看板那张表在【管家视角里
  // 一直在跑】（节拍由 pollTick 判：连接正常 30 s、断开回到今天那两档）。所以数得出来的
  // TICK_MS ms 表多了一张 —— 被钉的那件事一个字没变：每个模块仍然只有一张表、切离管家视角一张不剩
  // （G1/H1 那一条）。反向验证：把 isBoardOpen() && 加回 steward-board.js 的 syncPolling → 本条真红。
  ok(docked && docked.intervals.filter(ms => ms === TICK_MS).length === 3,
    `B2d 看板没打开时也只有三张表（抽屉 + avatar + 看板各一；121-K2b 之前看板那张要等点开才起，现在左栏常开、它一直在跑，节拍改由 pollTick 判；实测 ${docked && JSON.stringify(docked.intervals)}）`);

  // ── ② 左栏：分组、验收 a/b、等待原因、chip ─────────────────────────────────────
  // 121-K4-2：不再需要「点开」这一步 —— 左栏常开。这里只等它把两件任务都画出来。
  const opened = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.groups.length >= 2 ? snapshot : null;
  })()`);
  ok(Boolean(opened), 'C1 左栏把任务索引画出来了（常开，不用先点开）');
  if (!opened) throw new Error('rail did not render');
  // 一行状态点下去＝把左栏滚到最需要你的那一组（§2.2「点开＝左栏滚到该组」），不再开合任何东西。
  await cdp.evaluate(`document.getElementById('stewardStatusLine').click(), true`);
  const jumped = await cdp.evaluate(`(() => {
    const section = document.querySelector('#railList .rail-group[data-group="needs_you"]');
    return section ? JSON.stringify({ found: true, collapsed: section.classList.contains('is-collapsed') }) : JSON.stringify({ found: false });
  })()`);
  ok(jumped === JSON.stringify({ found: true, collapsed: false }),
    `C1b 点一行状态＝把左栏滚到「等你」那一组（并保证那一组是展开的；实测 ${jumped}）`);
  // 124 还债①：多了「没人记过验收的那件」，分组 2 → 3。
  ok(opened.groups.length === 3, `C2 按任务分成三件（实测 ${opened.groups.length}）`);
  const groupM = opened.groups.find(group => group.missionId === missionId) || null;
  const groupC = opened.groups.find(group => group.missionId === created.C) || null;
  ok(Boolean(groupM) && groupM.title === MISSION_TITLE,
    `C3 事项行显示【容器】标题（117h 第 0 步的 missionTitle；实测「${groupM && groupM.title}」）`);
  // 117u-G2 **重钉 C4**（B4：钱与验收从事项头搬到卡尾一行）：被钉的事实没变 —— 验收 a/b 仍然
  // 【显示且只显示一次】，变的只是它印在哪儿（多线程事项印在组尾，单线程印在那唯一一张卡的卡尾）。
  // 新判据比旧的强：旧的只问「事项头那串里有没有它」，新的连「有没有印重复」一起钉。
  ok(Boolean(groupM) && groupM.facts.length === 1
    && groupM.facts[0].includes(fill('stewardShell.board.acceptance', { done: 1, total: 2 })),
    `C4 验收 a/b 印在卡尾那一行事实里，且整组只印一次（实测 ${groupM && JSON.stringify(groupM.facts)}）`);
  ok(Boolean(groupM) && groupM.taskCount === '2'
    && groupM.facts.join(' ').includes(fill('stewardShell.board.threadCount', { n: 2 })),
    `C4b 任务行显示线程数（行上一枚小计数「${groupM && groupM.taskCount}」＋卡尾事实行那一枚）`);
  // ── C4c 124 还债①（40 号文 §8.5 ①）：看板也说得出「未记录验收」──────────────────────
  // 修前这一格是【沉默】的：列表行上只有容器那三个数，`total === 0` 既可能是「记过、是空的」，
  // 也可能是「压根没人记过」，看板两者都当没话说 —— 而沉默会被读成「没进展」。
  // 抽屉从 124-P1 起就分得开（它读详情投影里的 ledger），看板这一刀才补上。
  // 用户 2026-09-15 拍板的口径：**只在收工了却没人记过时印**（还在跑／等你时不说）。
  // 按【标题】定位而不是按 missionId：attach 已经写了 session.missionId（聚合行那一侧当场就跟上了，
  // 这一组的 acceptance 读的就是它），但左栏归组用的是【卡片上】那个 missionId，而卡片来自投影索引、
  // 这一拍可能还没赶上 —— 于是它暂时自成一组。那是存量行为（与本刀无关），而本条判据要钉的
  // 是「这一格到底说不说话」，不该被归组的时序绑架。
  const groupUnrec = opened.groups.find(group => String(group.text || '').includes(THREAD_UNREC)) || null;
  ok(Boolean(groupUnrec),
    `C4c 那件「没人记过验收」的活在左栏里（找 ${emptyMissionId}，屏上有 ${JSON.stringify(opened.groups.map(g => g.missionId))}）`);
  ok(Boolean(groupUnrec) && groupUnrec.facts.join(' ').includes(zh['stewardShell.board.acceptanceUnrecorded']),
    `C4c 它印的是「${zh['stewardShell.board.acceptanceUnrecorded']}」（修前这里什么都不说；实测 ${groupUnrec && JSON.stringify(groupUnrec.facts)}）`);
  // 同屏对照两条，缺一不可 —— 只验正面的话，把判据写成「恒印」也能绿：
  //   · 记过的那件（M 有两条容器验收项）仍然印 a/b，不许被新分支抢走；
  //   · C 自己带账本（mission start 过），所以它【记过】—— 一个字都不该说。
  ok(Boolean(groupM) && !groupM.facts.join(' ').includes(zh['stewardShell.board.acceptanceUnrecorded']),
    `C4d 记过验收的那件仍然印 a/b，不印「未记录验收」（实测 ${groupM && JSON.stringify(groupM.facts)}）`);
  ok(Boolean(groupC) && !groupC.facts.join(' ').includes(zh['stewardShell.board.acceptanceUnrecorded']),
    `C4e 自带账本的那条【记过】，看板闭嘴（实测 ${groupC && JSON.stringify(groupC.facts)}）`);

  // 117u-G2 **重钉 C5**（B1：单线程事项不画事项层 —— §11.15.2 病 2「标题字面重复两次」）。
  // 旧判据钉的是「自成事项的事项名回落成它自己的标题」，那句话在修前【必然】导致同一个名字上下
  // 印两遍（事项头一遍、线程行一遍）。新判据钉的是这一刀真正要保证的事：那种组根本没有事项层，
  // 而那个名字在整组里【恰好出现一次】（在线程卡上）—— 更强，也更贴用户看见的那张截图。
  ok(Boolean(groupC) && groupC.grouped === false && groupC.hasHead === false && groupC.title === '',
    `C5 自成事项（1 事项 = 1 线程）不画事项层（实测 grouped=${groupC && groupC.grouped} hasHead=${groupC && groupC.hasHead}）`);
  const nameHits = (haystack, needle) => String(haystack || '').split(needle).length - 1;
  ok(Boolean(groupC) && nameHits(groupC.text, THREAD_C) === 1,
    `C5b 那个名字在整组【看得见的字】里恰好出现一次（修前事项头与线程行各印一遍 —— §11.15.2 病 2 的「季度复盘 / 季度复盘」；实测 ${groupC && nameHits(groupC.text, THREAD_C)} 次）`);
  ok(Boolean(groupM) && groupM.grouped === true && groupM.hasHead === true && groupM.title === MISSION_TITLE,
    `C5c ≥2 条线程的事项【仍然】画那一行小标题「事项名 · N 条」（实测「${groupM && groupM.title}」＋${groupM && JSON.stringify(groupM.pills)}）`);
  ok(Boolean(groupM) && groupM.threads.length === 2 && groupC.threads.length === 1,
    'C6 线程行按事项归位（M 两条、C 一条）');
  const rowA = groupM && groupM.threads.find(thread => thread.sessionId === created.A);
  const rowB = groupM && groupM.threads.find(thread => thread.sessionId === created.B);
  // 117u-G2 **重钉 C7**（B2「色 ≠ 态」）：五态从那颗点的 data-state 搬到卡头那枚药丸上 ——
  // 点自此只说「这是哪条线程」（线程色），态由药丸独家承担。判据跟着事实走，且比旧的多钉一件：
  // 线程卡上【一颗按状态上色的点都没有】（.steward-board-dot 计数为 0），否则两套信号又混回去了。
  ok(Boolean(rowA) && rowA.state === 'needs_you' && Boolean(rowB) && rowB.state === 'running',
    `C7 线程行五态经 mission-state.js，写在卡头那枚药丸上（A=${rowA && rowA.state} / B=${rowB && rowB.state}）`);
  ok(Boolean(rowB) && rowB.statePillText === zh['mission.state.running'],
    `C7b 药丸上那句人话仍然只出自 t('mission.state.*')（实测「${rowB && rowB.statePillText}」）`);
  ok(Boolean(rowA) && rowA.stateDots === 0 && Boolean(rowB) && rowB.stateDots === 0
    && rowA.hueDots === 1 && rowA.bars === 1,
    `C7c 色 ≠ 态：线程卡上零颗按状态上色的点，只有一根色条＋一颗线程色点（实测 A 状态点=${rowA && rowA.stateDots} 色点=${rowA && rowA.hueDots} 色条=${rowA && rowA.bars}）`);
  ok(Boolean(rowA) && rowA.wait.length > 0,
    `C8 等你那条给出等待原因（116h 的 wait.label 单点判定；实测「${rowA && rowA.wait}」）`);
  // 117u-G2 **重钉 C8b**（B2 的直接后果）：修前没在等的那一行会把五态人话再印一遍 —— B2 之后
  // 卡头那枚药丸已经把这句话说过了，等待行再说一次就是 §11.15.2 病 3 那串等重灰字。所以新判据是
  // 「没在等就一个字都不说」，同一件事实的另一面（药丸仍然说得出来）由上面的 C7b 钉着。
  ok(Boolean(rowB) && rowB.wait === '' && rowB.statePillText === zh['mission.state.running'],
    `C8b 没在等的那条【不再重复印状态】（药丸已经说了；实测等待行「${rowB && rowB.wait}」／药丸「${rowB && rowB.statePillText}」）`);
  // 117u-G2 **重钉 C9**（B3「事实降级」）：权限与模型只在【与全局不同】时才印。两侧都验 ——
  // A／B 跟随全局（不印），C 定了会话级权限档（印）。旧判据「每行都有」在 B3 之后正是要消灭的病
  // （§11.15.2 病 3：每行都印一遍「跟随全局」，信息量为零、墨量却与线程名争重心）。
  const rowC = groupC && groupC.threads.find(thread => thread.sessionId === created.C);
  ok(Boolean(rowA) && rowA.chips.length === 0 && Boolean(rowB) && rowB.chips.length === 0,
    `C9 跟随全局的行【不印】权限与模型（实测 A=${rowA && JSON.stringify(rowA.chips)} B=${rowB && JSON.stringify(rowB.chips)}）`);
  ok(Boolean(rowC) && JSON.stringify(rowC.chips) === JSON.stringify(['permission', 'model']),
    `C9b 定过会话级权限档的那一行【印】出紧凑快切 chip：权限＋模型（引擎收进模型菜单；实测 ${rowC && JSON.stringify(rowC.chips)}）`);
  ok(Boolean(rowA) && ['prioritize', 'stop', 'open', 'classic'].every(action => rowA.actions.includes(action)),
    `C10 行操作齐备（优先／停止／打开／2.0；实测 ${rowA && JSON.stringify(rowA.actions)}）`);
  // 117l D4（用户第四轮走查①）：只加不改 —— 真在问你的那一行多一枚 pill，其它行没有。
  ok(Boolean(rowA) && JSON.stringify(rowA.asksYou) === JSON.stringify([zh['stewardShell.board.asksYou']]),
    `C10b 挂着 question 待决的那一行有「它在问你」pill（实测 ${rowA && JSON.stringify(rowA.asksYou)}）`);
  ok(Boolean(rowB) && rowB.asksYou.length === 0,
    `C10c 在跑（没人在问你）的那一行【没有】这枚 pill（实测 ${rowB && JSON.stringify(rowB.asksYou)}）`);
  // ── 117u-G2 新钉：B2 药丸不印两遍 ／ B4 卡尾一行 ／ B5「＋ 线程」搬家 ────────────────
  // B2 的收口：真有人在问你时，「它在问你」那枚更具体的顶替笼统的五态药丸 —— 两枚并排就是把
  // 同一句话印两遍（§11.15.2 病 3 的同一个模具）。态本身没丢：它在卡上的 data-state 里（C7）。
  ok(Boolean(rowA) && rowA.asksYou.length === 1 && rowA.statePillText === '' && rowA.state === 'needs_you',
    `C10e 有「它在问你」的那一行不再并排印一枚五态药丸（态仍在卡上：${rowA && rowA.state}；实测药丸「${rowA && rowA.statePillText}」）`);
  ok(Boolean(rowB) && rowB.asksYou.length === 0 && rowB.statePillText === zh['mission.state.running'],
    `C10f 没有待决的那一行照印五态药丸（实测「${rowB && rowB.statePillText}」）`);
  // B4：标题右侧只剩「最后动静」那一段 —— 钱与验收已经搬去卡尾（C4 钉的是那一半）。
  // 「只剩最后动静」的可证伪形式：卡头恰好一段 meta，而验收那句话【只】出现在卡尾事实行里、
  // 卡头里一个字都没有（把钱与验收搬回卡头，这一条立刻红）。
  const acceptanceSay = fill('stewardShell.board.acceptance', { done: 1, total: 2 });
  ok(Boolean(rowA) && rowA.headMeta.length === 1 && !rowA.headMeta[0].includes(acceptanceSay)
    && Boolean(groupM) && groupM.facts[0].includes(acceptanceSay),
    `C10g 卡头右侧只有一段 meta（「最后动静」），钱与验收只在卡尾那一行（实测卡头 ${rowA && JSON.stringify(rowA.headMeta)}）`);
  // B5：「＋ 线程」从事项头右上角收进卡尾那排次级动作（悬停才亮的那一档）。
  ok(opened.missionHeadNewThread === 0 && Boolean(rowA) && rowA.newThreadInTail === 1 && Boolean(rowC) && rowC.newThreadInTail === 1,
    `C10h 「＋ 线程」收进卡尾的次级动作，事项头上一枚不剩（实测 事项头=${opened.missionHeadNewThread} A 卡尾=${rowA && rowA.newThreadInTail} C 卡尾=${rowC && rowC.newThreadInTail}）`);
  // B2 的【真绘制】证据：色条不是「DOM 里有那个节点」就算数 —— 量它渲染出来的宽度与真背景色。
  // 必须趁看板【还开着】量：下面 C10d 点完「它在问你」会顺手把看板收起来（openThread →
  // setBoardOpen(false)），收起来之后看板里所有节点的 rect 都是 0，那不是没画出来，是量错了时候。
  const boardPaint = await cdp.evaluate(`(() => {
    const measure = selector => {
      const bar = document.querySelector(selector + ' .steward-tcard-bar');
      if (!bar) return '';
      return Math.round(bar.getBoundingClientRect().width) + 'px|' + getComputedStyle(bar).backgroundColor;
    };
    const paint = id => measure('#railList .steward-board-thread[data-session-id="' + id + '"]');
    return {
      barA: paint('${created.A}'),
      barB: paint('${created.B}'),
      // 121-K6b（§5「色号按任务」）：C 自成一个任务，A／B 同属容器 M —— 三根色条正好把
      //「同任务同色、不同任务不同色」这两半都量出来。
      barC: paint('${created.C}'),
    };
  })()`);
  await cdp.evaluate(`document.querySelector('#railList .steward-board-thread[data-session-id="${created.A}"] .steward-board-pill.is-asks-you').click(), true`);
  ok(Boolean(await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.drawerHidden === false && snapshot.nowThread ? snapshot : null;
  })()`)), 'C10d 点这枚 pill 就是打开抽屉（问答框在那儿）');

  // ── 117u-G2 B2「三面同色」的自证（§11.15.6 验收 1）─────────────────────────────
  // 同一条线程在【看板卡】与【线程详情栏卡头】上必须是同一个 data-thread-hue，而且这个号必须
  // 逐字等于那张【模块级登记表】现在发给它的号 —— 页面里 steward-conversation.js 只被求值一次，
  // 动态 import 拿到的是【同一个模块实例、同一张 Map】，所以对话流那一面（markThread 写的号
  // 出自同一个函数）由构造保证一致。三处若有任何一处自己算色，这一条立刻红。
  // 顺带钉住「号是有效的」：四色循环发出来的号只能是 1..4，取不到会是空串或 0。
  const hueProof = await cdp.evaluate(`(async () => {
    const conv = await import('/js/steward-conversation.js');
    const card = document.querySelector('#railList .steward-board-thread[data-session-id="${created.A}"]');
    const head = document.getElementById('stewardDrawerHead');
    // 121-K6b（§5）：B 与 A 同属容器 M，C 自成一个任务。
    const sibling = document.querySelector('#railList .steward-board-thread[data-session-id="${created.B}"]');
    const other = document.querySelector('#railList .steward-board-thread[data-session-id="${created.C}"]');
    const paint = node => {
      const bar = node && node.querySelector('.steward-tcard-bar');
      if (!bar) return '';
      const style = getComputedStyle(bar);
      return Math.round(bar.getBoundingClientRect().width) + 'px|' + style.backgroundColor;
    };
    return {
      board: card ? (card.dataset.threadHue || '') : '',
      drawer: head ? (head.dataset.threadHue || '') : '',
      sibling: sibling ? (sibling.dataset.threadHue || '') : '',
      other: other ? (other.dataset.threadHue || '') : '',
      registryA: String(conv.stewardThreadHueFor('${created.A}')),
      registryB: String(conv.stewardThreadHueFor('${created.B}')),
      registryC: String(conv.stewardThreadHueFor('${created.C}')),
      hues: conv.STEWARD_THREAD_HUES,
      barDrawer: paint(head),
    };
  })()`);
  ok(Boolean(hueProof) && hueProof.board !== '' && hueProof.board === hueProof.drawer && hueProof.board === hueProof.registryA,
    `C12 同一条线程在【看板卡】与【线程详情栏卡头】上是同一个色号，且逐字等于那张模块级登记表发的号（实测 看板=${hueProof && hueProof.board} 详情栏=${hueProof && hueProof.drawer} 登记表=${hueProof && hueProof.registryA}）`);
  // 121-K6b **重钉 C12b**（34 号文 §5「色号按任务分配、线程继承任务色」）：原判据钉的是「右栏
  // 小行也问同一张表」，而右栏自本刀起【只叠在途的线程】（§2.6「其它在途」），B 此刻已收工、
  // 不在那一栏 —— 那一面的同色由 S 组（真有在途线程的那一段）与新件 focus-rail.browser 钉。
  // 这里换钉本刀的要害：**A 与 B 同属容器 M，所以它们拿同一个号**（修前必然是两个号）。
  // 反向验证：把 stewardThreadHueFor 的键改回 sessionId → 本条与 C12d 第三个合取项同时红。
  ok(Boolean(hueProof) && hueProof.sibling !== '' && hueProof.sibling === hueProof.board
    && hueProof.registryB === hueProof.registryA,
    `C12b 同一个任务下的两条线程拿【同一个】号（线程继承任务色；实测 A=${hueProof && hueProof.board} B=${hueProof && hueProof.sibling}）`);
  // 号必须【真的按首次询问顺序循环发】，不是谁都拿一号：C 自成一个任务，所以它与 M 那两条
  // 一定拿到不同的号（把 stewardThreadHueFor 换成常量，这一条立刻红）。
  ok(Boolean(hueProof) && hueProof.hues === 4
    && [hueProof.board, hueProof.other].every(hue => Number(hue) >= 1 && Number(hue) <= hueProof.hues)
    && hueProof.board !== hueProof.other && hueProof.registryC !== hueProof.registryA,
    `C12c 发出来的号落在四色循环里，两个不同的【任务】两个号（1..${hueProof && hueProof.hues}；实测 M=${hueProof && hueProof.board} C=${hueProof && hueProof.other}）`);
  // 真绘制：色条是 3px 实色、看板与详情栏同一条线程同一个颜色值。
  // 光钉 data-thread-hue 是不够的 —— 属性写对了但样式层没接上，屏幕上仍然什么都没有。
  ok(Boolean(boardPaint) && /^3px\|rgb/.test(boardPaint.barA) && /^3px\|rgb/.test(boardPaint.barB)
    && Boolean(hueProof) && boardPaint.barA === hueProof.barDrawer
    && boardPaint.barA === boardPaint.barB,
    `C12d 色条真的画出来了：看板卡上 3px 实色、同一条线程在看板与详情栏同色、同一任务的两条线程同色（实测 A=${boardPaint && boardPaint.barA} 详情栏=${hueProof && hueProof.barDrawer} B=${boardPaint && boardPaint.barB}）`);
  // 反面：另一个任务真的是另一种颜色（否则「同色」那一条可以靠「全都同色」蒙混过去）。
  ok(Boolean(boardPaint) && /^3px\|rgb/.test(boardPaint.barC) && boardPaint.barC !== boardPaint.barA,
    `C12e 不同任务的色条是不同的颜色值（实测 M=${boardPaint && boardPaint.barA} C=${boardPaint && boardPaint.barC}）`);

  // 121-K2b 重钉：点开看板【不再多】一条 —— 那第三条在看板收起时就已经在跑了（B2d）。
  // 钉的仍然是同一件事：看板不会因为一次开合长出第二张表。
  ok(opened.intervals.filter(ms => ms === TICK_MS).length === 3,
    `C11 点开看板不再多一条计时器（收起时就已经是三张，121-K2b 删掉了「看板关着不刷」那道门；实测 ${JSON.stringify(opened.intervals)}）`);

  // ── 117l-B2 ②：看板视觉的可判定结果（用户第五轮走查 2）──────────────────────────
  const transparent = value => /rgba\(0, 0, 0, 0\)|transparent/.test(String(value));
  // 121-K4-2：那条 toolbar 搬进左栏的看板密度栏头 —— 紧凑密度下它【收起来】（display:none），
  // 这正是「268px 那一档只留一行主信息」的可判定形式。
  ok(opened.topGround && opened.topGround.split('|')[2] === 'none',
    `V1 并发上限那一条在紧凑密度下收起（看板密度才出现；实测 ${opened.topGround}）`);
  // V2 那张「事项卡」随 B1 口径反转而退役（多线程任务是一行任务行，不是一张裹起来的卡）——
  // 它的可判定形式换成：任务行【真的在】，而且它与线程行是同一枚卡基元（同一个类）。
  ok(Boolean(groupM) && groupM.hasHead === true && groupM.grouped === true,
    'V2 多线程任务是一行任务行（与线程行同一枚卡基元），不再是一张把线程行裹起来的玻璃卡');
  ok(opened.threadRule && /^0px\|1px\|20px$/.test(opened.threadRule),
    `V3 同一个任务下第一条线程行不画上边线、第二条画 1px 分隔线，两条都缩进 --sp-5=20px（121-K4：缩进改由 padding 给；实测 ${opened.threadRule}）`);
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

  // ── ⑦ 121-K4：「关掉」退役，抽屉的 × 只松开用户钉的焦点 ──────────────────────────
  // 右栏是常驻的一列（§2.6），所以「把右栏收起来并记住」这件事不再存在 —— 那枚「关掉」与它的
  // 本机偏好（wcw.stewardNowClosed）一起没了，否则存量用户会拿到一个右栏永远空着、且没有回头路的
  // 死状态（原来把它请回来的唯一路径就是行上的「打开」）。抽屉自己那枚 × 仍在，语义收窄成
  // 「松开我钉的这一条」：右栏不收起，焦点回落到自动挑选（等你＞在跑＞失败＞最近）。
  await cdp.evaluate(`document.getElementById('stewardDrawerCloseBtn').click(), true`);
  // 不等「抽屉藏起来」那一帧：closeNow 随即把同一份抽屉按【自动挑选】的焦点重新开在右栏里
  // （常驻栏的语义就是「总有一件在眼前」），所以那一帧可能根本不出现。等它落定即可。
  await sleep(600);
  const closed = await cdp.evaluate(BOARD);
  ok(closed && closed.nowHidden === false,
    `F1 抽屉的 × 不再收起右栏（常驻的一列；实测 hidden=${closed && closed.nowHidden}）`);
  ok(closed && closed.nowClosedPref === '',
    `F1b 本机偏好里一个字都没写（wcw.stewardNowClosed 已随「关掉」退役；实测「${closed && closed.nowClosedPref}」）`);
  ok(closed && closed.drawerParent === 'stewardFocus' && closed.drawerHidden === false,
    `F1c 抽屉那一份仍在右栏里（焦点松开了那一钉、回落到自动挑选；实测 parent=${closed && closed.drawerParent} hidden=${closed && closed.drawerHidden}）`);
  await cdp.evaluate(`document.querySelector('.steward-board-thread[data-session-id="${created.A}"] [data-action="open"]').click(), true`);
  const reopened = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.nowHidden === false && snapshot.nowThread === ${JSON.stringify(THREAD_A)} ? snapshot : null;
  })()`);
  ok(Boolean(reopened), 'F2 行上的「打开」把右栏的焦点钉到这一条（121-K4：右栏本来就在，钉的是焦点）');
  ok(reopened && reopened.nowClosedPref === '' && reopened.groups.length > 0,
    'F2b 「打开」一路上不写任何本机偏好；左栏照旧开着（没有「盖着自己要看的东西」那回事了）');

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
  // 121-K2b（34 号文 §6.2）**重钉 E2b**：这一条原本断言的是「派事件之前，行里没有它」——
  // 那是 117r-D2 造这个时序时的【前提】，不是它要守的结论。K2b 之后这个前提不成立了：
  // `thread.created` 一到，左栏当场把那一行重拉了（§6.3 的指标 e，新件实测 ~87 ms），
  // 而这【正是本波要的】。所以翻面钉「它已经在行里了」。
  // 「手里那批行没有它时焦点事件照样打得开」这条路【没有失去覆盖】：E2f 派的是一条根本
  // 不存在的 id（行里永远不会有它），钉的就是同一条路 ＋ 它的有界性。
  // 反向验证：把 steward-board.js 的 EVENT_STREAM_ROW_EVENTS 那一圈注释掉 → 本条真红。
  const beforeFocus = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    const ids = (Array.isArray(snapshot.groups) ? snapshot.groups : []).flatMap(g => g.threads.map(t => t.sessionId));
    return ids.includes('${idD}') ? snapshot : null;
  })()`) || await cdp.evaluate(BOARD);
  ok(boardIdsOf(beforeFocus).includes(idD),
    `E2b 线程在看板取过行【之后】才建出来，但 thread.created 推送一到左栏当场就有了它（121-K2b §6.3 指标 e；实测 ${JSON.stringify(boardIdsOf(beforeFocus))}）`);
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
    `E2c 右栏把这条【刚建出来的】线程打开（实测「${focusedNew && focusedNew.nowThread}」）`);
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

  // ── 收摊：把前面几组【故意挂着】的回合真停掉 ───────────────────────────────────────
  // 121-K4 修夹具：那几发不 await 的回合原来靠 helper 的 20 s 客户端超时「自己死掉」——
  // 一个既不可靠（机器慢一点就死得比 B1 还早，整组塌方）又有副作用（死得晚就占着并发位）的
  // 收摊方式。现在两头都写死：要它活的给 10 分钟，不要它了就【显式停掉】。
  // 必须停：D1 刚把「同时最多」改成 3，而 A／B 两条挂着的回合正占着两个位；不停的话下面
  // R 组那条新回合会一直排队（实测 R6「线程 F 的新回合也在飞了」永远等不到）。
  for (const id of [created.A, created.B]) {
    await request(appPort, 'POST', '/api/stop', { sessionId: id }, token);
  }

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
  // 121-K4：那枚「关掉」随浮层右栏退役 —— 同一条真实交互现在是抽屉自己的 ×（closeDrawer 会
  // stopPolling，随后行上的「打开」再 startPolling，相位照样从这一刻重新起算）。
  await cdp.evaluate(`document.getElementById('stewardDrawerCloseBtn').click(), true`);
  await sleep(600);   // 同 F1：抽屉随即按自动焦点重开，不等「藏起来」那一帧
  // 121-K4：左栏常开，不用先拉开。先等这一条线程的行真的渲染出来再点（不然 querySelector 拿到 null）。
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
  request(appPort, 'POST', '/api/chat/stream', { sessionId: idE, message: 'hang here', cwd: workE }, token, 600000);
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
  request(appPort, 'POST', '/api/chat/stream', { sessionId: idF, message: 'hang here', cwd: workF }, token, 600000);
  ok(Boolean(await liveOn(idF)), 'R6 线程 F 的新回合也在飞了（服务端投影 activeTurn=true）');
  // 121-K2b（34 号文 §6.2／§6.3 指标 a）**重钉 R7**：这一条原本钉的是一笔【债】——
  // 「看板行上的『打开』与行标题走 focusThread()，不派事件，抽屉那边一无所知，于是右栏已经
  // 开着这条线程时它一次都不刷」。K2b 把它还清了：回合一起跑，thread.state 当场到，右栏
  // 在 1 s 级别内翻成「进行中」＋「它正在说」，**不需要任何交互**。
  // 紧跟的 R8（行上『打开』这一路自己也得刷）一个字没动 —— 它钉的是另一件事，而且断连时
  // 那条路仍是唯一能救回来的眼睛。
  // 反向验证：把 steward-drawer.js 与 steward-board.js 两处 EVENT_STREAM_ROW_EVENTS 订阅都
  // 注释掉 → 本条回到修前那一帧（「已收工」＋「它刚说」）即红。
  const liveF = await waitForEval(cdp, `(() => {
    const snapshot = ${BOARD};
    return snapshot.nowState === ${JSON.stringify(zh['mission.state.running'])}
      && snapshot.nowLastSayHead === ${JSON.stringify(zh['stewardShell.drawer.liveSay'])} ? snapshot : null;
  })()`, 60);
  ok(Boolean(liveF),
    `R7 推送到了就【自己发现】：一次交互都没有，右栏在 3 s 内从「${zh['mission.state.done']}」＋「${zh['stewardShell.drawer.lastSay']}」翻成「${zh['mission.state.running']}」＋「${zh['stewardShell.drawer.liveSay']}」（121-K2b 还清 32 号文 §5 记的那笔债；实测 state=「${liveF && liveF.nowState}」head=「${liveF && liveF.nowLastSayHead}」）`);
  // ── R8 治抖动（34 号文 §13.6 登记①）：造一段真正的【事件流断连态】，再证同一件事在推送
  // 死了之后仍然成立 ────────────────────────────────────────────────────────────────────
  // R7 证的是「推送到了会自己翻」；R8 原来紧跟着用同一条线程 F 测「点『打开』也会翻」——
  // 但 F 这一刻已经被 R7 的推送翻过了，点开的时候门早就是开着的，断言从来没有真的把「点『打开』
  // 自己会不会刷」这件事考过（写的时候以为在守门，其实门是画上去的）。换一条【全新】的线程 F2，
  // 在事件流真的断掉之后重新走一遍同款交互，才是这条债真正要还的东西。
  const idF2 = await settleThread(THREAD_F2, workF2);
  ok(Boolean(idF2), `R8pre0 断连测试用的这一条【无账本、已跑完一个回合】线程就位（${idF2 || '失败'}）`);
  await waitForEval(cdp, `!!document.querySelector('.steward-board-thread[data-session-id="${idF2}"] [data-action="open"]')`);
  await cdp.evaluate(`document.querySelector('.steward-board-thread[data-session-id="${idF2}"] [data-action="open"]').click(), true`);
  const settledF2 = await waitForDrawer(THREAD_F2, zh['mission.state.done'], zh['stewardShell.drawer.lastSay'], '', 10000);
  ok(Boolean(settledF2.snapshot), `R8pre1 右栏（此刻仍连着）开在线程 F2 上，是「${zh['mission.state.done']}」那一帧——断连测试的干净起点`);

  // 真正断掉：只挡路由（setBlockedURLs）挡不掉【已经建立】的那条流——它是早先那次连接成功
  // 之后一直开着的 fetch+ReadableStream，跟这一刻才生效的挡毫无关系。真正能打断它的是
  // event-stream.js 自己的 connect()：每次重连开头都会先 abortCurrent() 把旧连接掐掉，再发
  // 新请求——那条新请求才是挡的对象。而重连的唯一扳机是【在场信号变了】（§4.2 的 sync()），
  // 本仓没有第二个写口。用现成的「管家｜工作台」分段钮切一下视角（lens 变了）就是这个扳机；
  // 挡先钉住、再切一圈 classic→steward，两次重连尝试都会当场被挡撞回去。
  await cdp.send('Network.setBlockedURLs', { urls: ['*/api/events/stream*'] });
  const cutLens = async mode => {
    await cdp.evaluate(`(() => { const sel = document.getElementById('cfgShellMode'); if (!sel) return false; sel.value = ${JSON.stringify(mode)}; sel.dispatchEvent(new Event('change')); return true; })()`);
    await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === ${JSON.stringify(mode)} ? 1 : null`);
  };
  await cutLens('classic');
  await sleep(700);   // 去抖 300ms + 一发被挡的请求落地
  await cutLens('steward');   // 切回来：既是第二次撞挡的确认，也把 UI 摆回能点行的视角
  await sleep(700);

  // R8pre2：断连是真的——另建一条挂进同一事项的线程，此刻不靠任何交互，它不该在 1.2 s 内出现
  // 在左栏（推送死了；兜底节拍拉满到 config.stewardPollMs=${POLL_MS}ms，这个窗口内轮询不可能
  // 命中）。这条判据把「断连」从「我们相信挡住了」变成「屏幕上真的看不见它的效果」。
  const probe = await request(appPort, 'POST', '/api/sessions', { title: '断连期间新建的探针', cwd: home }, token);
  const probeId = probe && probe.json && probe.json.session && probe.json.session.id;
  await request(appPort, 'POST', `/api/missions/${encodeURIComponent(missionId)}/threads`, { action: 'attach', sessionId: probeId }, token);
  await sleep(1200);
  const probeShown = await cdp.evaluate(`!!document.querySelector('.steward-board-thread[data-session-id="${probeId}"]')`);
  ok(Boolean(probeId) && probeShown === false,
    `R8pre2 事件流真的断了：断连期间新挂进事项的这条线程 1.2 s 内没有出现在左栏（推送死了，兜底节拍 ${POLL_MS}ms 太慢；实测 shown=${probeShown}）`);

  // 在断连的窗口里让 F2 开一个新回合（服务端投影 activeTurn=true，与 R3／R6 同一条路，
  // 只是这次没有推送把它带上屏幕）。
  request(appPort, 'POST', '/api/chat/stream', { sessionId: idF2, message: 'hang here', cwd: workF2 }, token, 600000);
  ok(Boolean(await liveOn(idF2)), 'R8pre3 线程 F2 的新回合真的在飞了（服务端投影 activeTurn=true）——这一步发生在抽屉那次强刷【之后】、事件流【断连期间】');
  await sleep(1200);
  const staleF2 = await cdp.evaluate(BOARD);
  ok(Boolean(staleF2) && staleF2.nowThread === THREAD_F2 && staleF2.nowState === zh['mission.state.done'],
    `R8pre4 断连时右栏【自己不会翻】：1.2 s 过去仍是「${zh['mission.state.done']}」——这就是 R8 要救的那一帧（实测「${staleF2 && staleF2.nowState}」）`);

  // R8：对着这条【右栏已经开着、事件流已经断连】的线程，再点一次行上的「打开」——
  // focusThread() 末尾的强刷（syncNow）走一发普通 HTTP GET，不经那条被挡住的 SSE 路由，
  // 断连时它是唯一能把这一帧救回来的路（32 号文 §5 记的那笔债的「断连」半，K2b 只还了「连着」半）。
  await waitForEval(cdp, `!!document.querySelector('.steward-board-thread[data-session-id="${idF2}"] [data-action="open"]')`);
  const clickedAt = Date.now();
  await cdp.evaluate(`document.querySelector('.steward-board-thread[data-session-id="${idF2}"] [data-action="open"]').click(), true`);
  const flippedF2 = await waitForDrawer(THREAD_F2, zh['mission.state.running'], zh['stewardShell.drawer.liveSay'], '开工了', 30000);
  ok(Boolean(flippedF2.snapshot) && Date.now() - clickedAt <= 5000,
    `R8 断连时对【右栏已经开着的那条线程】再点一次行上的「打开」→ 5 s 内状态行由「${zh['mission.state.done']}」变「${zh['mission.state.running']}」、「${zh['stewardShell.drawer.lastSay']}」换成「${zh['stewardShell.drawer.liveSay']}」（实测 ${Date.now() - clickedAt}ms；事件流已断连，这一路走的是 syncNow 自己的 HTTP 强刷，不经推送——这才是 R8 真正要考的门）`);
  ok(Boolean(flippedF2.snapshot) && flippedF2.snapshot.nowLastSay.includes('开工了'),
    `R8b 换上来的是【新那一回合】流出来的话，不是上一回合的落盘原话（实测「${flippedF2.snapshot && flippedF2.snapshot.nowLastSay}」）`);

  // 收摊：解除断连——清掉路由挡之后，用同一枚「切一下逼重连」的扳机再来一圈，S 组接下来
  // 要三条新线程的状态都能在预算内上屏，全靠推送。
  await cdp.send('Network.setBlockedURLs', { urls: [] });
  await cutLens('classic');
  await sleep(400);
  await cutLens('steward');
  const reconnected = await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === 'steward' ? 1 : null`);
  ok(Boolean(reconnected), 'R8fin 收摊：切回管家视角重新触发连接（S 组接下来靠推送）');

  // ── S F3（32 号文 §2.2「线程即频道」）：右栏是「现在这几件」──────────────────────────────
  // 此刻壳里已经有三种状态的线程：A 停在 question 待决（等你）、B／E／F 的回合挂着（在跑）、
  // 再造一条 G 走完一个回合（已收工）。右栏要把它们按【服务端行序】叠起来：焦点那条是抽屉本体，
  // 其余是小行；已收工的折成一行；等你的那条给「就地回答」。
  // 快照只读 DOM（textContent／dataset／子节点数），不碰任何模块私有状态；文案一个字都不断言
  // （新键还没进 locale，断言结构不断言中文）。
  const NOW = `(() => {
    const now = document.getElementById('stewardSide');
    const body = document.getElementById('stewardFocus');
    if (!now || !body) return null;
    const focusId = now.dataset.focusId || '';
    // 列内顺序：#stewardFocus 的三个直系子节点按 DOM 顺序摊平 —— 两条 stack 摊成各自的行，
    // 抽屉那一格顶上 data-focus-id。这就是「抽屉插在它自己那一格里」的可判定形式。
    const order = [];
    for (const child of body.children) {
      if (child.classList.contains('steward-now-stack')) {
        for (const item of child.children) order.push(item.dataset.sessionId || '');
      } else if (child.id === 'stewardDrawer') order.push(focusId);
      else order.push('?' + (child.id || child.className));
    }
    return {
      focusId,
      order,
      hidden: now.hidden,
      count: (now.querySelector('.steward-now-count') || {}).textContent || '',
      drawerTitle: (document.getElementById('stewardDrawerTitle') || { textContent: '' }).textContent.trim(),
      drawerParent: document.getElementById('stewardDrawer') && document.getElementById('stewardDrawer').parentElement
        ? document.getElementById('stewardDrawer').parentElement.id : '',
      active: document.activeElement ? (document.activeElement.id || '') : '',
      // 121-K6b 诊断：左栏那一面每条线程行现算出来的五态与 tone。焦点栏的「其它在途」过滤读的是
      // 同一处判据，所以这两份对不上就说明过滤那一行错了（而不是「没有在途的线程」）。
      railStates: [...document.querySelectorAll('#railList .steward-board-thread[data-session-id]')]
        .map(node => [node.dataset.sessionId, node.dataset.state || '', node.dataset.tone || '']),
      rows: [...body.querySelectorAll('.steward-now-thread')].map(item => ({
        sessionId: item.dataset.sessionId || '',
        tone: item.dataset.tone || '',
        title: (item.querySelector('.steward-now-thread-title') || { textContent: '' }).textContent.trim(),
        pill: (item.querySelector('.steward-board-pill') || { textContent: '' }).textContent.trim(),
        // F5a（27 号文 §11.13.1「F 追加」）：药丸里那枚由五态【派生】出来的字形。读路径本身 ——
        // 三条不同五态的行必须给出三枚不同的字形，否则「加了图标」等于没加。
        pillGlyph: [...item.querySelectorAll('.steward-board-pill svg path')].map(node => node.getAttribute('d')).join('|'),
        hue: item.dataset.threadHue || '',
        bar: (() => {
          const bar = item.querySelector('.steward-tcard-bar');
          if (!bar) return '';
          return Math.round(bar.getBoundingClientRect().width) + 'px|' + getComputedStyle(bar).backgroundColor;
        })(),
        hasSay: Boolean(item.querySelector('.steward-now-thread-say')),
        say: (item.querySelector('.steward-now-thread-say') || { textContent: '' }).textContent.trim(),
        hasAnswer: Boolean(item.querySelector('[data-action="answer"]')),
        blocks: item.querySelectorAll('.steward-now-thread-main > *').length,
      })),
    };
  })()`;
  // 三条线程【就地造】，不借用上面几组留下来的那几条：跑到这里已经两三分钟，早先那两条（A 的
  // question 待决、B 的挂起回合）在真服务器上可能已经收尾或被仲裁器停掉 —— 借它们等于把本组的
  // 结论建在别组的副作用上（实测过一次：到这一组时 A 不再等你、B 已停工）。
  // 同上：E／F／F2 三条在 R 组里被重新点起来的回合到这里已经没人要了，显式停掉，把并发位
  // 让给 G/H/I（「同时最多」此刻是 3）。
  for (const id of [idE, idF, idF2]) {
    await request(appPort, 'POST', '/api/stop', { sessionId: id }, token);
  }
  const workG = path.join(root, 'work-g');
  const workH = path.join(root, 'work-h');
  const workI = path.join(root, 'work-i');
  for (const dir of [workG, workH, workI]) fs.mkdirSync(dir, { recursive: true });
  // 与 settleThread 同一条路，只是回合【不】收尾（provider 的 ask/hang 两支），所以不 await。
  const startThread = async (title, cwd, message) => {
    const made = await request(appPort, 'POST', '/api/sessions', { title, cwd }, token);
    const id = (made && made.json && made.json.session && made.json.session.id) || '';
    if (!id) return '';
    await request(appPort, 'POST', `/api/missions/${encodeURIComponent(missionId)}/threads`, { action: 'attach', sessionId: id }, token);
    request(appPort, 'POST', '/api/chat/stream', { sessionId: id, message, cwd }, token, 600000);
    return id;
  };
  const idG = await settleThread(THREAD_G, workG);
  const idH = await startThread(THREAD_H, workH, 'ask about south');
  const askedH = await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === idH);
    return Boolean(row && row.asksYou && String(row.asksYou.kind || ''));
  }, token);
  const idI = await startThread(THREAD_I, workI, 'hang here');
  const liveI = await liveOn(idI);
  ok(Boolean(idH) && Boolean(askedH) && Boolean(idI) && Boolean(liveI),
    `S1b 另外两种状态也就位：一条停在 question 待决（等你，${idH || '失败'}）、一条回合挂着（在跑，${idI || '失败'}）`);
  // 121-K4-2：左栏常开，不用再「先把看板拉开」这一步（那一步原来是为了让表重新起来）。
  // 行的新鲜度由推送与那张一直在跑的兜底表给（B2d／C11 钉着它只有一张）。
  ok(Boolean(idG), `S1 第三种状态就位：一条跑完一个回合、此刻没在跑的线程（五态「${zh['mission.state.done']}」；${idG || '失败'}）`);
  // 服务端行序与列内顺序【同一时刻】各取一份再比：行序本身会随状态与 updatedAt 变，
  // 拿一份旧快照去等 DOM 追上来，等到的可能是「两边都对、只是不同时刻」的假红。
  // 121-K6b 重写 matchOrder（34 号文 §2.6「其它在途：其余【非收工】线程的最紧密度行」）。
  // 修前这里比的是「列内顺序 === 服务端行序」逐字相等；焦点栏只留在途之后那条等式不再成立，
  // 而【不能】改成「按某个字段过滤一遍再比」—— 行上只有 `aggregateState`（那是**任务**的聚合态，
  // 同一个容器里的每条线程都是同一个值，本件那 11 条全属容器 M，照它过滤等于一条都过滤不掉；
  // 第一版就是这么写的，实测期望 11 条、实到 1 条，白等 30 s 还把后面几条一起带红）。
  // 每条线程自己的五态是【客户端由卡片派生】的（mission-state.js 一处），行上没有那个字段，
  // 在测试里再抄一份就是第二个状态机。所以判据换成两条不依赖那个字段、且同样可证伪的事实：
  //   ① **只过滤、不重排**：列内顺序是服务端行序的【子序列】；
  //   ② **过滤的是收工**：栏里每一条的 tone 都是 attention/active（DOM 上现成的），且此刻真在途
  //      的那两条（H 等你、I 在跑）都在场。
  const isSubsequence = (small, big) => {
    let at = 0;
    for (const id of small) { at = big.indexOf(id, at) + 1; if (at === 0) return false; }
    return true;
  };
  const matchOrder = async budgetMs => {
    const startedAt = Date.now();
    let ids = [];
    let snapshot = null;
    while (Date.now() - startedAt < budgetMs) {
      const projected = await request(appPort, 'GET', '/api/missions?limit=200', null, token);
      ids = (((projected && projected.json) || {}).missions || []).map(row => String(row.sessionId));
      snapshot = await cdp.evaluate(NOW).catch(() => null);
      if (snapshot && isSubsequence(snapshot.order, ids)
        && snapshot.rows.length > 0
        && snapshot.rows.every(row => row.tone === 'attention' || row.tone === 'active')
        && snapshot.rows.some(row => row.sessionId === idI)) break;
      await sleep(200);
    }
    return { ids, snapshot };
  };
  const matched = await matchOrder(30000);
  const serverOrder = matched.ids;
  const stacked = matched.snapshot;
  ok(stacked && isSubsequence(stacked.order, serverOrder)
    && stacked.rows.length > 0
    && stacked.rows.every(row => row.tone === 'attention' || row.tone === 'active'),
    `S2 焦点栏按【服务端行序】叠在途那几条（117s-A 的状态优先序在 13d 排一次，右栏原样消费、只过滤不重排）：列内 ${JSON.stringify(stacked && stacked.order)} 是服务端 ${serverOrder.length} 条行序的子序列，且每条 tone 都在途（实测 ${JSON.stringify((stacked && stacked.rows.map(row => row.tone)) || null)}；左栏同判据 ${JSON.stringify((stacked && stacked.railStates) || null)}）`);
  ok(stacked && stacked.focusId && stacked.order.includes(stacked.focusId)
    && stacked.rows.every(row => row.sessionId !== stacked.focusId)
    && stacked.drawerParent === 'stewardFocus'
    && stacked.rows.length === stacked.order.length - 1,
    `S3 焦点那一条【就是那份抽屉】（同一个节点仍挂在 #stewardFocus 里），它不再另画一条小行：列内 ${stacked && stacked.order.length} 格 → ${stacked && stacked.rows.length} 条小行 ＋ 1 份抽屉`);
  const rowOf = (snapshot, id) => (snapshot && snapshot.rows.find(row => row.sessionId === id)) || null;
  const rowG = rowOf(stacked, idG);
  // 121-K6b 重钉 S4（34 号文 §2.6「其它【在途】：其余非收工线程的最紧密度行」）：已收工的那条
  // 自此【不进焦点栏】—— 它在左栏里，点一下就换成焦点；摆在焦点栏里只会把「此刻该看什么」冲淡。
  // 原判据钉的是「收工的折成一行、没有回答口」，那是它还在这一栏时的形状；现在钉的是更强的
  // 「它根本不在这一栏」，同一条设计意图的下一步。
  // 反向验证：把 steward-board.js renderNow 里那句 `if (!inFlight(row)) return;` 拔掉 → 它冒出来 → 本条红。
  ok(rowG === null,
    `S4 已收工的那条【不进焦点栏】（其它在途只叠非收工的；实测 ${rowG ? 'tone=' + rowG.tone + ' 仍在栏里' : '不在栏里'}）`);
  const nowRowH = rowOf(stacked, idH);
  ok(nowRowH && nowRowH.tone === 'attention' && nowRowH.hasSay === true && nowRowH.say.length > 0 && nowRowH.hasAnswer === true,
    `S5 等你的那条多一行「它在问你」（行上 asksYou.text，06i 单点算出）并给出就地回答口（实测「${nowRowH && nowRowH.say}」answer=${nowRowH && nowRowH.hasAnswer}）`);
  let nowRowI = rowOf(stacked, idI);
  // 主会话复核（34 号文 §13.13）：matchOrder 只等到「I 进了栏且 tone 在途」就放行，而 I 的药丸从
  // 「交办中」（dispatching）翻到「在跑」比进栏晚一拍——串行三跑一红两绿。对药丸单独再等一拍到
  // 五秒（有判据的等，与 steward-drawer H1 同一模具），拍数用尽仍不是「在跑」才红。
  for (let attempt = 0; attempt < 25 && !(nowRowI && nowRowI.pill === zh['mission.state.running']); attempt++) {
    await sleep(200);
    const again = await cdp.evaluate(NOW).catch(() => null);
    nowRowI = rowOf(again, idI) || nowRowI;
  }
  ok(nowRowI && nowRowI.tone === 'active' && nowRowI.pill === zh['mission.state.running'],
    `S5b 在跑的那条是展开档（tone=active）且状态药丸说的是五态人话（实测 tone=${nowRowI && nowRowI.tone}「${nowRowI && nowRowI.pill}」）`);
  // F5a（§11.13.1「F 追加」）：五态各【一枚】图标进状态药丸。三条行此刻分别是已收工／等你／在跑，
  // 所以三枚字形必须两两不同 —— 同一枚图标配三种文字等于没加图标；一枚都不画则是没落地。
  // 判据仍然只有一份：图标名由 icons.js 从五态值派生，五态本身仍由 mission-state.js 判。
  // 121-K6b：收工那一条已经不在这一栏了（S4），所以这里剩两档可比 —— 等你与在跑的字形必须不同。
  // 「收工那一枚也有自己的字形」由左栏那一面钉（同一份 icons.js 派生，同一处判据）。
  // 121-K6b（§5 四面同色的右栏那一面）：在途小行的色号仍然问【同一张登记表】，色条也真画出来了。
  // 这一条搬到 S 组是因为 C12b 那一处的 B 已经收工、不再进焦点栏（§2.6「其它在途」）；
  // H／I 是这一段里真在途的两条，所以这里量得到。
  const nowHueProof = await cdp.evaluate(`(async () => {
    const conv = await import('/js/steward-conversation.js');
    return { h: String(conv.stewardThreadHueFor('${idH}')), i: String(conv.stewardThreadHueFor('${idI}')) };
  })()`);
  const railRowI = rowOf(stacked, idI);
  ok(Boolean(railRowI) && railRowI.hue !== '' && Boolean(nowHueProof) && railRowI.hue === nowHueProof.i
    && /^3px\|rgb/.test(railRowI.bar),
    `S5d 焦点栏那条在途小行（D4 最紧密度卡）的色号问的是同一张登记表，色条 3px 实色真画出来了（实测 小行=${railRowI && railRowI.hue} 登记表=${nowHueProof && nowHueProof.i} 色条=${railRowI && railRowI.bar}）`);
  const pillGlyphs = [nowRowH, nowRowI].map(row => (row && row.pillGlyph) || '');
  ok(pillGlyphs.every(glyph => glyph.length > 0) && new Set(pillGlyphs).size === 2,
    `S5c F5a：两条不同五态的状态药丸各带一枚【不同】的字形（等你／在跑；实测 ${JSON.stringify(pillGlyphs.map(glyph => glyph.slice(0, 24)))}）`);
  // 121-K4（34 号文 §2.6）：右栏的标题条（「现在这几件」＋「关掉」＋头上那个数）随浮层一起退役 ——
  // 那个数在顶栏的全局状态胶囊与左栏组头里已经各有一处，同一件事不印三遍。翻面钉住它不在了。
  ok(stacked && stacked.count === '',
    `S6 右栏头上那个数随标题条退役（计数改由顶栏胶囊与左栏组头承担；实测「${stacked && stacked.count}」）`);
  // ── 点一行 = 让它成为抽屉本体（5 s 内） ───────────────────────────────────────────
  // 121-K6b 重钉：已收工的 G 自本刀起【不在焦点栏里】（S4），所以这一下改从**左栏**那一行点 ——
  // §2.6 的原话就是「点左栏任一行可换焦点」，两条路走的是同一个 focusThread 入口（本模块唯一那个
  // 「有人请求聚焦」的口），换掉的只是点哪一枚按钮。
  const clickedRowAt = Date.now();
  await cdp.evaluate(`document.querySelector('#railList .steward-board-thread[data-session-id="${idG}"] .steward-board-thread-title').click(), true`);
  const swapped = await waitForEval(cdp, `(() => {
    const snapshot = ${NOW};
    return snapshot && snapshot.focusId === ${JSON.stringify(idG)}
      && snapshot.drawerTitle === ${JSON.stringify(THREAD_G)} ? snapshot : null;
  })()`);
  ok(Boolean(swapped) && Date.now() - clickedRowAt <= 5000,
    `S7 点左栏那条已收工的行 → 5 s 内它成为抽屉本体，抽屉里的内容【就是这条线程的】（标题「${swapped && swapped.drawerTitle}」；实测 ${Date.now() - clickedRowAt}ms）`);
  // 换焦点只换「谁是抽屉」：在途那几条小行一条不多一条不少（收工的 G 当了焦点也不会给自己补一条
  // 小行；上一位焦点同样收工，所以它也不会冒出来）。反向：把 renderNow 的过滤拔掉 → 两边行数都
  // 变成全量、这一条与 S4 同时红。
  const inFlightIds = snapshot => JSON.stringify((snapshot ? snapshot.rows : []).map(row => row.sessionId));
  ok(swapped && swapped.rows.every(row => row.sessionId !== idG)
    && inFlightIds(swapped) === inFlightIds(stacked),
    `S7b 换焦点只换「谁是抽屉」：在途那几条小行一个没变（换焦点前 ${inFlightIds(stacked)}，换焦点后 ${inFlightIds(swapped)}）`);
  // ── 就地回答：光标【当场】落进抽屉既有的回答口，那条线程也成了抽屉本体 ─────────────────────
  // 为什么要在【同一次 evaluate 里】点完就读：抽屉自己的 openThread 末尾也会 focusAsk（117l D4），
  // 所以「过几秒之后光标在输入框里」这句话【不能证明】就地回答做了什么 —— 写这条锁时先做了反向
  // 验证：把 answerHere 里那两行焦点交接删掉，整件仍然 ALL PASS。真正属于本刀的是【这一帧】：
  // 点下去的那一刻抽屉的数据还在飞，它自己只把焦点放在标题上（openThread 的同步段），要等一趟
  // 网络回来才轮到 focusAsk；答话的人这段时间没有光标可用。就地回答当场把光标交给抽屉既有的
  // 输入口，所以点完立刻读，activeElement 就已经是那两个输入框之一。
  const clickedAnswerAt = Date.now();
  const answering = await cdp.evaluate(`(() => {
    document.querySelector('.steward-now-thread[data-session-id="${idH}"] [data-action="answer"]').click();
    return ${NOW};
  })()`);
  ok(answering && answering.focusId === idH
    && (answering.active === 'stewardDrawerAskInput' || answering.active === 'stewardDrawerInput'),
    `S8 就地回答按下去的【那一帧】：那条线程已经是抽屉本体，光标已经在抽屉既有的输入口里（实测 activeElement=${answering && answering.active}，不是抽屉加载时自己抓走的 stewardDrawerTitle；${Date.now() - clickedAnswerAt}ms）`);
  // 光标先落进底部那个输入口（S8 已经断言过），抽屉这一趟的数据还在飞 —— 117k 的「读取中…」闸
  // 落下之后标题才是真的，所以这一条单独等一次（等的是内容，不是焦点）。
  const answeringOn = await waitForEval(cdp, `(() => {
    const snapshot = ${NOW};
    return snapshot && snapshot.drawerTitle === ${JSON.stringify(THREAD_H)} ? snapshot : null;
  })()`);
  ok(Boolean(answeringOn) && answeringOn.focusId === idH
    && (answeringOn.active === 'stewardDrawerAskInput' || answeringOn.active === 'stewardDrawerInput'),
    `S8b 抽屉里开着的正是那一条（标题「${answeringOn && answeringOn.drawerTitle}」），闸落之后光标仍在抽屉的输入口里（实测 ${answeringOn && answeringOn.active}）—— 答案因此走抽屉那唯一一条递话路径，右栏没有第二个输入框`);

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
  // 121-K4：左栏是两视角共用的同一份 DOM —— 切到工作台视角它【不收】，只有右栏收起。
  // 这正是「一份数据一处控件」那条原则的可判定形式（§2.1 第 10 条）。
  ok(Boolean(classic) && classic.nowHidden === true && classic.groups.length > 0
    && classic.plusLabel === zh['rail.newThread'],
    `H2 右栏收起；左栏照旧在，且「＋」改口说「${zh['rail.newThread']}」（实测「${classic && classic.plusLabel}」）`);
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
