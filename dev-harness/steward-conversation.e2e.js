#!/usr/bin/env node
'use strict';

// 第117波 117c 真实浏览器 E2E（27 号文 §5 117c 行「真实浏览器 e2e：提议→批准→线程回合启动；
// 递话→撤回→线程回退检查点」）：管家对话区与递话的端到端。
//   ① 开关开 → 进管家壳 → POST /api/steward/visit 新到访 → 问候＋要点＋一行按钮渲染，
//      feed 里没有上次对话（零用户气泡）；
//   ② 对如意说一句 → 先出「···」占位 → 流式文字 → steward_reply 的 say 与 ≤3 个按钮；
//   ③ 点 dismiss 按钮 → 整行按钮换成灰字回执；
//   ④ 输入含线程标题的话 → chip 变「→ 周报-W36」→ Enter 直接递 → 「递给了『周报-W36』。」回执与
//      「撤回 N」倒计时 → 点撤回 → 先 POST /api/stop 再 POST /api/session/rewind（顺序由 fetch 探针
//      记录）→ 灰字「已撤回…」＋管家追问「那递给谁？」；
//   ⑤ 与任何线程都不相关的陈述句 → chip 变「→ 如意 · 另起一件」；
//   ⑥ 切回经典壳后无残留定时器（管家状态轮询与撤回倒计时都被清掉）。
//
// 与 steward-shell.e2e.js 同一套 CDP 无头驱动；管家回合的确定性来自 dev-harness/fake-openai.js 的
// FAKE_REPLY_SEQUENCE（照 steward-runner.e2e.js 的用法：第 N 个流式请求回第 N 条剧本文本）。
// 后端零改动：本件只调 116 已经有的路由。
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

const THREAD_TITLE = '周报-W36';
// 117r-D3（用户第八轮走查②「关键词匹配……会把输入框内容挤没」，截图里那一行是一整句问 AMD 行情的
// 长话）：造一条标题本身就超过 STEWARD_TITLE_MAX(24) 的线程，复现「chip 命中一条长标题线程」这个场景。
// 词汇跟 THREAD_TITLE 与下面各测试用例的输入文字（周报/接着做/把华南的表补上/落叶/院子/第一句/
// 第二句/结论 等）刻意不重叠——preroute 是按词命中打分的，撞了词会让别的用例意外变成 kind:'unsure'。
const LONG_TITLE = '帮我查一下AMD超威半导体NASDAQ最新收盘价涨跌基本面新闻给我一句总评';
const LONG_TITLE_SHORT = [...LONG_TITLE].slice(0, 24).join('') + '…';   // stewardShortTitle 的算法：前 24 个码点 + 省略号
const STEWARD_SAY = '我看了一眼，现在这条线程停在等你。';
// 117l D1／D3 新增三段剧本。剧本按【流式请求的先后】取，所以顺序就是本件的用例顺序：
//   [0] 测试②的管家回合（四个 acts —— 后端归一后前端只该渲染 ≤3 个）；delayMs 让「···」占位有窗口
//   [1] 测试 F（预判命中却【不】直递）那一轮管家回合
//   [2][3] 测试 Q（连发两句）的两轮；[2] 慢一点，好让第二句真的排上队
//   [4] 递话之后那条【线程】自己的回合（内容不参与断言，钳到末条）
const HINT_SAY = '这句我先接着办。';
const QUEUE_SAY_1 = '第一句收到了。';
const QUEUE_SAY_2 = '第二句也收到了。';
// 117s-C：管家写的 markdown（标题／粗体／列表／代码围栏／mermaid 围栏）＋ 两枚 XSS 载荷。
// 后端只把 say 截到 600 字并做 id→显示名的人话化（13h stewardHumanizeSay），【不】过滤 HTML ——
// 所以这两枚载荷是原样到前端的，净化只可能发生在共享渲染器的 sanitizeNode 里，这正是要钉的。
const MD_SAY = "## 结论先行\n\n**偏空**，理由三条：\n\n- 量能没跟上\n- 外盘走弱\n- 北向连续净卖\n\n```js\nconst risk = 1;\n```\n\n```mermaid\ngraph TD; A-->B;\n```\n\n<img src=x onerror=\"alert(1)\"> <script>alert(2)</script>";
const MD_WHY = '## 依据不该被渲染 **也不该加粗**';
const stewardScript = say => JSON.stringify({ say, why: '', acts: [], actions: [] });
const REPLY_SEQUENCE = [
  {
    text: JSON.stringify({
      say: STEWARD_SAY,
      why: '来自线程总览与收件箱',
      acts: [
        { label: '知道了', kind: 'dismiss', primary: true },
        { label: '改一下', kind: 'dismiss' },
        { label: '再看看', kind: 'dismiss' },
        { label: '第四个', kind: 'dismiss' },
      ],
      actions: [],
    }),
    delayMs: 900,
  },
  stewardScript(HINT_SAY),
  { text: stewardScript(QUEUE_SAY_1), delayMs: 1500 },
  stewardScript(QUEUE_SAY_2),
  '好的，我接着做。',
  // 117s-C（用户第九轮走查⑦「输出要支持 markdown、制图」）：一条【真·markdown】回复，顺带带上
  // 两枚注入载荷。放在剧本末条 —— FAKE_REPLY_SEQUENCE 超出即钳到末条，所以哪怕前面多跑了一个
  // 后台回合把序号推掉一格，本用例等到的仍然是这一条。why 里故意写 markdown：它是【机器回执】,
  // 必须原样上屏（本波的纪律：只有 say 走渲染器）。
  JSON.stringify({ say: MD_SAY, why: MD_WHY, acts: [], actions: [] }),
];

const { findBrowserExecutable } = require('./lib/browser-path');
const browserPath = findBrowserExecutable;

function request(port, method, pathname, body, token) {
  return new Promise(resolve => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: 8000,
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

async function waitForHttp(port, pathname, predicate, attempts = 120) {
  for (let i = 0; i < attempts; i++) {
    const result = await request(port, 'GET', pathname);
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
  if (!document.getElementById('stewardShell') || !window.state || !window.state.status || !window.state.config) return null;
  return { ready: true };
})()`;

// 对话流快照：全部走 textContent，不碰任何私有内部状态。
const FEED = `(() => {
  const feed = document.getElementById('stewardFeed');
  const chip = document.getElementById('stewardTarget');
  const rows = [...feed.querySelectorAll('.steward-msg')];
  return {
    rows: rows.length,
    users: feed.querySelectorAll('.steward-msg-user').length,
    // 117l D3：用户气泡的原文与「排队中」那一档（连发用例按这两项判定）。
    userSays: [...feed.querySelectorAll('.steward-msg-user .steward-say')].map(node => node.textContent),
    queued: [...feed.querySelectorAll('.steward-msg-user.is-queued .steward-say')].map(node => node.textContent),
    queuedTags: [...feed.querySelectorAll('.steward-msg-user .steward-queued')].map(node => node.textContent),
    // 117l D1：请求体（只留管家域的），用来钉 routeHint 真的进了 POST /api/steward/message。
    stewardBodies: (window.__ruyiStewardBodies || []).slice(),
    // 117l D5：※ 浮层里的两个小标题（只数【打开着】的那一个浮层 —— 关着的浮层也在 DOM 里，
    // 不加 :not([hidden]) 的话这一项恒非空、断言形同虚设）。
    whyHeads: [...feed.querySelectorAll('.steward-why-pop:not([hidden]) .steward-why-h')].map(node => node.textContent),
    composerNote: document.getElementById('stewardComposerNote')
      ? document.getElementById('stewardComposerNote').textContent : '',
    says: [...feed.querySelectorAll('.steward-say')].map(node => node.textContent),
    acts: [...feed.querySelectorAll('.steward-act')].map(node => node.textContent),
    primaries: feed.querySelectorAll('.steward-act.is-primary').length,
    receipts: [...feed.querySelectorAll('.steward-receipt')].map(node => node.textContent),
    typing: feed.querySelectorAll('.steward-typing').length,
    chip: chip && chip.querySelector('.steward-target-label') ? chip.querySelector('.steward-target-label').textContent : '',
    fetches: (window.__ruyiFetchLog || []).slice(),
    intervals: window.__ruyiLiveIntervals ? window.__ruyiLiveIntervals() : [],
    // 117j W2-3（头像跟着话走）：头像现在应该在【最后一条】管家的话左边那个 36px 槽里。
    // 全部走公开 DOM，不碰任何私有状态：谁是它的父节点、那个父节点属于哪一行、页面上还剩几个头像。
    avatarSlot: (() => {
      const avatar = document.getElementById('stewardAvatar');
      if (!avatar || !avatar.parentElement) return '';
      return avatar.parentElement.className || '';
    })(),
    avatarOnLastRuyi: (() => {
      const avatar = document.getElementById('stewardAvatar');
      const ruyiRows = [...feed.querySelectorAll('.steward-msg-ruyi')];
      const last = ruyiRows[ruyiRows.length - 1] || null;
      return Boolean(avatar && last && last.contains(avatar));
    })(),
    avatarCount: document.querySelectorAll('#stewardAvatar, .steward-avatar').length,
    avslots: feed.querySelectorAll('.steward-avslot').length,
    // 117l-B2 ④（用户第五轮走查 4「很多轮的看起来有点奇怪，尤其是边边那个点」）：
    // 管家那几行的分组／降噪状态。全部走公开 DOM（className、::before 的计算样式、按钮的
    // disabled 与计算底色），不碰模块私有状态。
    ruyiRows: [...feed.querySelectorAll('.steward-msg-ruyi')].map(node => ({
      groupStart: node.classList.contains('is-group-start'),
      groupEnd: node.classList.contains('is-group-end'),
      stale: node.classList.contains('is-stale'),
      hasAvatar: Boolean(node.querySelector('#stewardAvatar')),
      acts: node.querySelectorAll('.steward-act').length,
      disabledActs: [...node.querySelectorAll('.steward-act')].filter(btn => btn.disabled).length,
      // 幽灵档到底生没生效：不是最新那一行的按钮，计算出来的底色应该是全透明的。
      actBg: (() => {
        const btn = node.querySelector('.steward-act');
        return btn ? getComputedStyle(btn).backgroundColor : '';
      })(),
      // 空槽还画不画那个 8px 灰点：content 是 'none' 就说明那条规则真的没了。
      slotMark: (() => {
        const slot = node.querySelector('.steward-avslot');
        return slot ? getComputedStyle(slot, '::before').content : '';
      })(),
      // 组的左侧竖线画没画在这一行上。
      groupLine: getComputedStyle(node, '::before').content !== 'none',
    })),
    // 117s-C：最后一条管家的话的 markdown 结构与净化结果。全部走公开 DOM；innerHTML 只在这里【读】
    // 一次，为的是证明「onerror= 这几个字符在最终 DOM 里一个都不剩」。
    lastSay: (() => {
      const nodes = [...feed.querySelectorAll('.steward-msg-ruyi .steward-say')];
      const node = nodes[nodes.length - 1];
      if (!node) return null;
      const tail = [...node.children].filter(child => !child.classList.contains('steward-why-btn')).pop();
      return {
        md: node.classList.contains('md'),
        whiteSpace: getComputedStyle(node).whiteSpace,
        h2: node.querySelectorAll('h2').length,
        strong: node.querySelectorAll('strong').length,
        li: node.querySelectorAll('li').length,
        preCode: node.querySelectorAll('pre > code').length,
        mermaidBlocks: node.querySelectorAll('.mermaid-block').length,
        scripts: node.querySelectorAll('script').length,
        onerrorAttrs: [...node.querySelectorAll('*')].filter(el => el.hasAttribute('onerror')).length,
        rawHasOnerror: node.innerHTML.indexOf('onerror') >= 0,
        imgs: node.querySelectorAll('img').length,
        text: node.textContent,
        // ※ 还在句尾那一段里（markdown 之后它若掉出段落就会自己占一行）。
        whyInTail: Boolean(tail && tail.tagName === 'P' && tail.querySelector('.steward-why-btn')),
      };
    })(),
    // ※ 浮层里的行：不管开着还是收着都读（它们是机器回执，任何时候都该是纯文本）。
    // 取的是【lastSay 那一行】的浮层，不是「最后一个管家行」—— 后者可能是一行还只有「···」占位的
    // 新回合，于是浮层恒 null，与 lastSay 说的不是同一条消息。
    lastWhy: (() => {
      const nodes = [...feed.querySelectorAll('.steward-msg-ruyi .steward-say')];
      const last = nodes[nodes.length - 1];
      const row = last ? last.closest('.steward-msg-ruyi') : null;
      const pop = row ? row.querySelector('.steward-why-pop') : null;
      if (!pop) return null;
      return {
        lines: [...pop.querySelectorAll('.steward-why-line')].map(node => node.textContent),
        headings: pop.querySelectorAll('h1, h2, h3, strong, li').length,
      };
    })(),
    // 117s-C：来源小头（收件箱触发的那条回复才有）。
    sources: [...feed.querySelectorAll('.steward-source')].map(node => ({
      text: node.textContent,
      sessionId: node.dataset.sessionId || '',
      beforeSay: Boolean(node.nextElementSibling && node.nextElementSibling.classList.contains('steward-say')),
    })),
    presenceDot: (() => {
      const dot = document.getElementById('stewardPresenceDot');
      return dot ? String(dot.dataset.state || '') : '';
    })(),
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-conv-'));
const home = path.join(root, 'home');
const profile = path.join(root, 'profile');
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  // 116-5a:本件隔离回合/工具/台账,不测线程自动摘要(它有自己的 thread-brief.e2e.js)
  stewardThreadBriefV1: false,
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
  // 拉满轮询周期：测试窗口内收件箱不会自己 tick（剧本序号才可判定），前端的状态轮询计时器周期也
  // 因此是 120000 —— ⑥ 的「无残留定时器」按这个周期过滤。
  stewardPollMs: 120000,
  stewardVisitIdleMinutes: 60,
  stewardConversationRetention: 'visit',
  providers: [{
    id: 'fake', label: 'Fake', type: 'openai-compat',
    baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model',
    models: [{ id: 'fake-model', label: 'Fake' }],
  }],
}), 'utf8');

let fake = null;
let server = null;
let browser = null;
let cdp = null;
try {
  fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js'), String(providerPort)], {
    env: { ...process.env, FAKE_REPLY_SEQUENCE: JSON.stringify(REPLY_SEQUENCE) },
    windowsHide: true, stdio: 'ignore',
  });
  server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
    windowsHide: true, stdio: 'ignore',
  });
  ok(Boolean(await waitForHttp(appPort, '/health', result => result.status === 200, 300)), 'A1 workbench started'); // 117q:此启动门原吃默认 attempts=120(120×80ms=9.6s)小于本机冷启动实测 4.6-6.3s 且余量过窄,是「FAIL workbench up」假红的根;本文件此助手只此一处调用,仍按同批 12 处一致的编辑形态显式传 300 而不改默认(30 号文 P1-31)

  let token = '';
  for (let i = 0; i < 80 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A2 runtime token 可读');

  // 造一条真线程：递话的目标与预判的命中源都是它（POST /api/sessions 是既有路由，后端零改动）。
  const created = await request(appPort, 'POST', '/api/sessions', { title: THREAD_TITLE }, token);
  const threadId = created && created.json && created.json.session && created.json.session.id;
  ok(Boolean(threadId), `A3 线程「${THREAD_TITLE}」已建（${threadId || '失败'}）`);
  // 117r-D3 的长标题线程留到 D3 用例前面才建（见下方 D3-0）——到访（B3）按「最近更新」挑焦点线程，
  // 这里早建的话，B3 原来钉的「焦点线程是 THREAD_TITLE」这条断言会被新线程顶掉，平白炸掉一条老用例。

  const executable = browserPath();
  ok(Boolean(executable), 'A4 Edge/Chrome found');
  if (!executable || !threadId) throw new Error('prerequisites unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1440,1000',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A5 browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 两个探针：活计时器（周期）与请求日志（路径顺序）。都随每次刷新自动重装。
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
      window.__ruyiFetchLog = [];
      window.__ruyiStewardBodies = [];
      const nativeFetch = window.fetch;
      window.fetch = function (input, init) {
        try {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          const route = String(url).replace(/^https?:\\/\\/[^/]+/, '').split('?')[0];
          window.__ruyiFetchLog.push(route);
          // 117l：管家域的请求体也留一份 —— routeHint 是否真的进了 POST /api/steward/message，
          // 只有请求体说了算（URL 相同，差别全在 body 里）。
          if (route.indexOf('/api/steward/') === 0) {
            window.__ruyiStewardBodies.push({ route, body: String((init && init.body) || '') });
          }
        } catch { /* probe must never break the app */ }
        return nativeFetch.call(window, input, init);
      };
    })();`,
  });

  // addScriptToEvaluateOnNewDocument 只对【新文档】生效：首屏在装探针之前就加载完了，刷新一次让
  // 两个探针真正上到页面上（与 steward-shell.e2e.js 的做法一致）。
  await cdp.evaluate('location.reload(); true');
  ok(Boolean(await waitForEval(cdp, READY)), 'A6 应用就绪（组合根绑完、status 到达）');
  const baseline = await cdp.evaluate('({ thousand: (window.__ruyiLiveIntervals()||[]).filter(ms => ms === 1000).length })');

  // ─── ① 进管家壳 → 新到访 ───────────────────────────────────────────────────────
  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgShellMode');
    select.value = 'steward';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const visit = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return snapshot.rows > 0 ? snapshot : null;
  })()`);
  ok(Boolean(visit) && visit.says.some(text => text.startsWith(zh['stewardShell.chat.greeting'])),
    'B1 进壳即到访：第一句是问候（确定性文案，不调模型）');
  ok(Boolean(visit) && visit.says.some(text => text.includes(zh['stewardShell.chat.digestNone'])),
    'B2 「你不在的这段时间里」要点行在场（本次收件箱为空 → 明说没有新事）');
  ok(Boolean(visit) && visit.acts.includes(zh['stewardShell.chat.gotIt'])
    && visit.acts.some(label => label.includes(THREAD_TITLE)),
    `B3 一行按钮 = 「打开焦点线程」＋「知道了」（实测 ${JSON.stringify(visit && visit.acts)}）`);
  ok(Boolean(visit) && visit.users === 0 && visit.receipts.length === 0,
    'B4 feed 里没有上次对话（零用户气泡；上次对话已归档进行动流水）');
  ok(Boolean(visit) && visit.primaries === 1, 'B5 一次回合的主动作只有一个');
  ok(Boolean(await waitForEval(cdp, `(() => (${FEED}).fetches.includes('/api/steward/visit') || null)()`)),
    'B6 到访走的是既有的 POST /api/steward/visit（后端零改动）');

  // ─── ② 对如意说一句：「···」→ 流式文字 → say ＋ ≤3 按钮 ────────────────────────
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    input.focus();
    input.value = '现在都还好吗';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  const typing = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return snapshot.typing > 0 ? snapshot : null;
  })()`);
  ok(Boolean(typing) && typing.typing > 0, 'C1 管家思考时对话流末尾出「···」占位（不是转圈）');
  ok(Boolean(typing) && typing.users === 1, 'C2 用户的话立刻上屏（乐观气泡）');
  const replied = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return snapshot.says.some(text => text.indexOf(${JSON.stringify(STEWARD_SAY)}) >= 0) ? snapshot : null;
  })()`, 600);
  ok(Boolean(replied), 'C3 steward_reply 的 say 上屏（流式文字替换了占位）');
  // say 是【流式】上屏的，按钮行要等 steward_reply 那一帧到达才画 —— 断言按钮必须单独等一次，
  // 否则等到的是「刚流出第一段文字」那一瞬间的快照。
  const settledTurn = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return snapshot.acts.indexOf('再看看') >= 0 ? snapshot : null;
  })()`, 600);
  ok(Boolean(settledTurn) && settledTurn.typing === 0, 'C4 回合结束后「···」占位已消失');
  const turnActs = settledTurn ? settledTurn.acts.filter(label => ['改一下', '再看看', '第四个'].includes(label)) : [];
  ok(turnActs.length === 2 && !turnActs.includes('第四个'),
    `C5 一行按钮 ≤3（剧本给了 4 个，本回合只渲染出 3 个：知道了/改一下/再看看，第四个被丢弃；实测 ${JSON.stringify(turnActs)}）`);

  // ─── 117j W2-3：头像跟着话走（用户 2026-09-06 第二轮走查③，推翻「固定顶部」的拍板）────────
  ok(Boolean(typing) && typing.avatarOnLastRuyi === true,
    'W2-3a「···」占位一出现，头像就已经在那一行旁边（它是这一回合管家所在的位置）');
  ok(Boolean(settledTurn) && settledTurn.avatarSlot === 'steward-avslot',
    `W2-3b 回合结束后头像住在 36px 的槽里（实测父节点 class「${settledTurn && settledTurn.avatarSlot}」）`);
  ok(Boolean(settledTurn) && settledTurn.avatarOnLastRuyi === true,
    'W2-3c 头像在【最后一条】管家的话旁边');
  ok(Boolean(settledTurn) && settledTurn.avatarCount === 1,
    `W2-3d 全页只有一个头像节点 —— 是【搬】不是【复制】（实测 ${settledTurn && settledTurn.avatarCount} 个）`);
  ok(Boolean(settledTurn) && settledTurn.avslots >= 2 && settledTurn.avslots >= settledTurn.rows - settledTurn.users,
    `W2-3e 每一条管家的话都有槽（历史那些是空槽，靠 CSS 的 :empty::before 画静态点；实测槽 ${settledTurn && settledTurn.avslots} 个）`);
  ok(Boolean(settledTurn) && settledTurn.presenceDot !== '',
    `W2-3f 头部那枚 6px 状态点有态（头像搬走之后它是头部唯一的状态投影；实测「${settledTurn && settledTurn.presenceDot}」）`);

  // ─── ③ 点 dismiss → 灰字回执 ──────────────────────────────────────────────────
  const receiptsBefore = settledTurn ? settledTurn.receipts.length : 0;
  await cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('#stewardFeed .steward-act')];
    const target = buttons.reverse().find(node => node.textContent === '再看看');
    if (target) target.click();
    return Boolean(target);
  })()`);
  const settled = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return snapshot.receipts.length > ${receiptsBefore} ? snapshot : null;
  })()`);
  ok(Boolean(settled) && settled.receipts.includes(zh['stewardShell.chat.acked']),
    'D1 按钮落定：整行按钮换成灰字回执「知道了」');
  ok(Boolean(settled) && !settled.acts.includes('再看看'),
    'D2 落定后原来那一行按钮整体消失（不是只禁用）');

  // ─── ⑤ 与线程无关的陈述句 → chip「另起一件」 ──────────────────────────────────
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    input.focus();
    input.value = '把院子里的落叶扫一扫吧';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const chipNew = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return snapshot.chip.indexOf(${JSON.stringify(zh['stewardShell.compose.targetNew'])}) >= 0 ? snapshot : null;
  })()`);
  ok(Boolean(chipNew), `E1 什么都不像时 chip 显示「${zh['stewardShell.compose.targetNew']}」`);

  // ─── ④-1 117l D1（用户第四轮走查②）：输入含线程标题 → chip 只【提示】，Enter 仍发给管家 ──
  // 117l 重钉（语义收紧，不是放宽）：F1 此前钉的是「chip 变成 → 周报-W36」（= 预判即目标），
  // F2/F3 钉的是「Enter 直接递、请求打 /api/steward/act」。那是 117c 的世界。用户第四轮走查②
  // 原话「无论关键词匹配到什么，都要发给管家让它决定是哪个线程，是否是新线程」推翻了它 ——
  // 真机上「大A这周走势会怎么样」被「走势」命中美股那条线程，一句新话直递进去，把那条线程正在
  // 等的提问 supersede 掉（§11.9.2 ①⑥ 是同一起事故）。所以三条一起重钉成「预判只进 hint」，
  // companion 是下面 P 组的「手选仍直递」—— 直递这条路没有被删掉，只是必须由用户明示。
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    input.focus();
    input.value = ${JSON.stringify(THREAD_TITLE + ' 接着做，把华南的表补上')};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const chipHint = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return snapshot.chip.indexOf(${JSON.stringify(THREAD_TITLE)}) >= 0 ? snapshot : null;
  })()`);
  const hintCopy = zh['stewardShell.compose.targetSteward.hint'].replace('{{title}}', THREAD_TITLE);
  ok(Boolean(chipHint) && chipHint.chip === hintCopy,
    `F1 预判命中时 chip 是【提示】而不是目标：「${hintCopy}」（实测「${chipHint && chipHint.chip}」）`);

  const beforeHint = await cdp.evaluate('(window.__ruyiFetchLog || []).length');
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  const hinted = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return snapshot.says.some(text => text.indexOf(${JSON.stringify(HINT_SAY)}) >= 0) ? snapshot : null;
  })()`, 900);
  ok(Boolean(hinted), 'F2 预判命中的那句话仍然【经过管家回合】（管家自己回了一句）');
  const afterHint = hinted ? hinted.fetches.slice(beforeHint) : [];
  ok(afterHint.includes('/api/steward/message') && !afterHint.includes('/api/steward/act'),
    `F3 这一发打的是 POST /api/steward/message，【不是】 /api/steward/act（实测 ${JSON.stringify(afterHint)}）`);
  const hintBody = (hinted ? hinted.stewardBodies : []).filter(row => row.route === '/api/steward/message').pop();
  let hintJson = null;
  try { hintJson = JSON.parse((hintBody && hintBody.body) || 'null'); } catch { hintJson = null; }
  ok(Boolean(hintJson) && hintJson.routeHint && hintJson.routeHint.kind === 'thread'
    && Array.isArray(hintJson.routeHint.hits) && hintJson.routeHint.hits.some(hit => hit.sessionId === threadId),
    `F3b 请求体带 routeHint，命中里有那条线程的 sessionId（实测 ${JSON.stringify(hintJson && hintJson.routeHint)}）`);
  ok(Boolean(hintJson) && hintJson.message === THREAD_TITLE + ' 接着做，把华南的表补上'
    && JSON.stringify(hintJson.routeHint).indexOf(THREAD_TITLE) < 0,
    'F3c 用户那句话逐字不动，且 routeHint 里【没有】标题（服务端只信 sessionId，标题自己重查）');

  // ─── ④-2 117l D3（用户第四轮走查⑥）：连着说两句 ────────────────────────────────
  // 修前 sendToSteward 第一行是 `if (!message || streaming) return null;` —— 第二句不上屏、
  // 不排队、不报错，只是没了。现在第二句立刻上屏并标「排队中」，前一条收尾后按序发。
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    input.focus();
    input.value = '第一句：先看看昨天的日志';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.value = '第二句：顺便把结论写下来';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  const queuedSnapshot = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return snapshot.queued.length === 1 ? snapshot : null;
  })()`, 600);
  ok(Boolean(queuedSnapshot), 'Q1 第二句立刻上屏并标「排队中」（修前它被静默丢弃）');
  ok(Boolean(queuedSnapshot) && queuedSnapshot.queued[0].indexOf('第二句') >= 0,
    `Q1b 排队的是【第二句】，第一句照常在跑（实测 ${JSON.stringify(queuedSnapshot && queuedSnapshot.queued)}）`);
  ok(Boolean(queuedSnapshot) && queuedSnapshot.queuedTags.includes(zh['stewardShell.chat.queued']),
    'Q1c 「排队中」是真节点（读屏念得到），不是 CSS 生成内容');
  ok(Boolean(queuedSnapshot) && queuedSnapshot.userSays.some(text => text.indexOf('第一句') >= 0)
    && queuedSnapshot.userSays.some(text => text.indexOf('第二句') >= 0),
    'Q1d 两句都在对话流里（一句都没丢）');
  const bothReplied = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return snapshot.says.some(text => text.indexOf(${JSON.stringify(QUEUE_SAY_2)}) >= 0) ? snapshot : null;
  })()`, 1200);
  ok(Boolean(bothReplied), 'Q2 排队那一句最终真的发出去并拿到了回复');
  const firstAt = bothReplied ? bothReplied.says.findIndex(text => text.indexOf(QUEUE_SAY_1) >= 0) : -1;
  const secondAt = bothReplied ? bothReplied.says.findIndex(text => text.indexOf(QUEUE_SAY_2) >= 0) : -1;
  ok(firstAt >= 0 && secondAt > firstAt,
    `Q3 两条回复【按序】落在对话流里（实测 ${firstAt} / ${secondAt}）`);
  ok(Boolean(bothReplied) && bothReplied.queued.length === 0,
    'Q3b 轮到它发的时候「排队中」那一档被摘掉');

  // ─── ④-3 手选目标仍然直递（companion：D1 没有删掉直递这条路，只是要用户明示）──────
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    input.focus();
    input.value = ${JSON.stringify(THREAD_TITLE + ' 接着做，把华南的表补上')};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitForEval(cdp, `(() => (${FEED}).chip.indexOf(${JSON.stringify(THREAD_TITLE)}) >= 0 || null)()`);
  await cdp.evaluate(`document.getElementById('stewardTarget').click(), true`);
  const pickedOne = await cdp.evaluate(`(() => {
    const option = [...document.querySelectorAll('#stewardTargetPicker .steward-target-option')]
      .find(node => node.textContent.indexOf(${JSON.stringify(THREAD_TITLE)}) >= 0);
    if (option) option.click();
    return Boolean(option);
  })()`);
  ok(pickedOne === true, 'P1 候选列表里能手选那条线程');
  const chipPicked = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return snapshot.chip === ${JSON.stringify(zh['stewardShell.compose.targetThread'].replace('{{title}}', THREAD_TITLE))} ? snapshot : null;
  })()`);
  ok(Boolean(chipPicked), `P2 手选之后 chip 才是【目标态】「→ ${THREAD_TITLE}」`);

  const beforeHand = await cdp.evaluate('(window.__ruyiFetchLog || []).length');
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  const handed = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return snapshot.says.some(text => text.indexOf('递给了') >= 0) ? snapshot : null;
  })()`, 600);
  ok(Boolean(handed) && handed.says.some(text => text.indexOf(THREAD_TITLE) >= 0),
    'P3 手选之后 Enter 仍然直递：管家只回一行「递给了『周报-W36』。」');
  ok(Boolean(handed) && handed.fetches.slice(beforeHand).includes('/api/steward/act'),
    'P3b 手选那一发走 POST /api/steward/act（直递这条路仍在，只是要用户明示）');
  const undoLabel = handed ? handed.acts.find(label => label.startsWith(zh['stewardShell.chat.undo'])) : '';
  ok(Boolean(undoLabel) && /撤回 \d+/.test(undoLabel),
    `F4 回执按钮是带倒计时的「撤回 N」（实测 ${JSON.stringify(undoLabel)}）`);
  // 117l D5（用户第四轮走查④）：※ 浮层里两段各有小标题。递话那一条的 ※ 里有「依据」（命中理由）。
  const whyOpened = await cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('#stewardFeed .steward-why-btn')];
    const last = buttons[buttons.length - 1];
    if (last) last.click();
    return Boolean(last);
  })()`);
  const whySnapshot = whyOpened ? await cdp.evaluate(FEED) : null;
  ok(Boolean(whySnapshot) && whySnapshot.whyHeads.includes(zh['stewardShell.chat.whyHeading']),
    `F4b ※ 浮层里有「依据」小标题（实测 ${JSON.stringify(whySnapshot && whySnapshot.whyHeads)}）`);
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");

  const clicked = await cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('#stewardFeed .steward-act')];
    const target = buttons.find(node => node.textContent.indexOf(${JSON.stringify(zh['stewardShell.chat.undo'])}) === 0);
    if (target) target.click();
    return Boolean(target);
  })()`);
  ok(clicked === true, 'F5 撤回按钮在 10 秒窄窗内可点');
  // 管家气泡的 textContent 末尾永远带一个「※」（依据浮层的触发器就挂在这一句里），所以这里按
  // 前缀/子串判定，不做全等。
  const undone = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return snapshot.says.some(text => text.indexOf(${JSON.stringify(zh['stewardShell.chat.whoInstead'])}) === 0) ? snapshot : null;
  })()`, 600);
  ok(Boolean(undone) && undone.receipts.some(text => text.startsWith(zh['stewardShell.chat.undone'])),
    'G1 撤回落定：灰字「已撤回…」（引擎无检查点时如实标注「改动请看 2.0 视窗」）');
  ok(Boolean(undone), 'G2 撤回后管家追问「那递给谁？」（i18n，不调模型）');
  const picker = await waitForEval(cdp, `(() => {
    const node = document.getElementById('stewardTargetPicker');
    if (!node || node.hidden) return null;
    return { options: node.querySelectorAll('.steward-target-option').length };
  })()`);
  ok(Boolean(picker) && picker.options >= 1,
    `G2a 撤回后就地打开候选列表（「那递给谁？」问完能立刻挑；实测 ${picker ? picker.options : 0} 项）`);
  await cdp.evaluate("document.getElementById('stewardComposerInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
  const stopAt = undone ? undone.fetches.lastIndexOf('/api/stop') : -1;
  const rewindAt = undone ? undone.fetches.lastIndexOf('/api/session/rewind') : -1;
  ok(stopAt >= 0 && rewindAt > stopAt,
    `G3 撤回的顺序是先 POST /api/stop 再 POST /api/session/rewind（实测 stop@${stopAt} rewind@${rewindAt}）`);
  const rewound = await request(appPort, 'GET', `/api/sessions/${threadId}`, null, token);
  const threadMessages = rewound && rewound.json && rewound.json.session && Array.isArray(rewound.json.session.messages)
    ? rewound.json.session.messages.length : -1;
  ok(threadMessages === 0, `G4 线程回退到递话前（这句话视为没发出去，剩余消息 ${threadMessages} 条）`);

  // ─── 117r-D3：预判命中【长标题】线程 —— chip 不许把输入框挤没，且能撤掉重来 ──────────
  // 用户第八轮走查②原话：「关键词匹配……最好不要和输入框放同一行，会把输入框内容挤没，要不放在
  // 输入框上面；而且匹配的没法删掉/关掉」。三条根因这里各钉一处：①标题截短（D3-1）、②输入框仍有
  // 可用宽度（D3-2，样式挪行是否真的生效，只有真机量出来才算数）、③× 能把这次自动预判撤掉、且不会
  // 随后续输入自己复活、清空输入框之后正常复位（D3-2c/D3-3/D3-4/D3-5）。
  //
  // 这条长标题线程放到现在才建（不是跟 A3 那条一起）：GET /api/steward/visit 按「最近更新」挑
  // 焦点线程，早建的话会把 B3 原来钉的「焦点线程是 THREAD_TITLE」顶掉，平白炸掉一条无关的老用例。
  const createdLong = await request(appPort, 'POST', '/api/sessions', { title: LONG_TITLE }, token);
  const longThreadId = createdLong && createdLong.json && createdLong.json.session && createdLong.json.session.id;
  ok(Boolean(longThreadId), `D3-0 长标题线程（${[...LONG_TITLE].length} 字）已建（${longThreadId || '失败'}）`);

  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    input.focus();
    input.value = ${JSON.stringify(LONG_TITLE + '，麻烦再帮我盯一下')};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const longHintCopy = zh['stewardShell.compose.targetSteward.hint'].replace('{{title}}', LONG_TITLE_SHORT);
  const longHint = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return snapshot.chip === ${JSON.stringify(longHintCopy)} ? snapshot : null;
  })()`);
  ok(Boolean(longHint),
    `D3-1 长标题线程命中之后 chip 走 stewardShortTitle 截短：「${longHintCopy}」（实测「${longHint && longHint.chip}」，原标题 ${[...LONG_TITLE].length} 字）`);

  // 下限怎么定的：.steward-composer 顶多 800px（steward-shell.css .steward-composer{max-width:800px}），
  // 除输入框外只有两枚 32px 圆键 + 两道 --sp-1 间隙 + 左右内边距，加起来远不到「行宽的 4 成」。chip
  // 现在挪到了输入框【上面】那一行（117r-D3 ②），不再跟输入框抢同一行的地盘，正常情况下 inputWidth
  // 该占 rowWidth 的 8~9 成。这里只要求 ≥60%，冗余给得足——本 bug 复现时那一行 chip 文案（截图里一
  // 整句话）把输入框挤到几乎 0px，跟「≥60%」差着好几倍，不会因几像素的字体/滚动条抖动而误判。
  const widthSnapshot = await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    const row = document.getElementById('stewardComposer');
    return { inputWidth: input.getBoundingClientRect().width, rowWidth: row.getBoundingClientRect().width };
  })()`);
  ok(widthSnapshot.rowWidth > 0 && widthSnapshot.inputWidth >= widthSnapshot.rowWidth * 0.6,
    `D3-2 长标题命中时输入框没被挤没：输入框 ${widthSnapshot.inputWidth.toFixed(1)}px / 行宽 ${widthSnapshot.rowWidth.toFixed(1)}px（要求 ≥60%）`);
  ok(widthSnapshot.inputWidth >= 200,
    `D3-2b 输入框宽度也过一个不依赖行宽的绝对下限 200px（实测 ${widthSnapshot.inputWidth.toFixed(1)}px）`);

  const clearVisible = await cdp.evaluate(`(() => {
    const clear = document.querySelector('#stewardTarget .steward-target-clear');
    return Boolean(clear) && clear.hidden === false;
  })()`);
  ok(clearVisible === true, 'D3-2c 自动命中时 × 是可见的（显隐判据不再只看有没有手选）');

  // 截图为证（验收②）：宽屏（真实窗口本来就是 1440×1000，≥1000px 达标，不用再 override）与窄屏
  // （390px，既有断点）各一张，长标题线程命中时的输入区。宽屏先拍，narrow 拍完立刻把 override 清掉——
  // 不然后面 R/H 两段断言会在一个被强制改过 viewport 的页面上跑，节外生枝。
  const shotDir = 'C:\\Users\\87179\\AppData\\Local\\Temp\\claude\\C--Users-87179-Documents-Claude-Code-ruyi-workbench-oss\\a075087e-ba4c-4de8-a8ad-4961390012d1\\scratchpad';
  const wideShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shotDir, '117r-D3-wide.png'), Buffer.from(wideShot.data, 'base64'));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(200);   // 给样式层的 390px 断点一拍时间应用
  const narrowShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shotDir, '117r-D3-narrow.png'), Buffer.from(narrowShot.data, 'base64'));
  await cdp.send('Emulation.clearDeviceMetricsOverride', {});
  await sleep(200);

  await cdp.evaluate(`(() => {
    const clear = document.querySelector('#stewardTarget .steward-target-clear');
    if (clear) clear.click();
    return Boolean(clear);
  })()`);
  const dismissed = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return snapshot.chip === ${JSON.stringify(zh['stewardShell.compose.targetSteward'])} ? snapshot : null;
  })()`);
  ok(Boolean(dismissed), `D3-3 点 × 之后 chip 回到「${zh['stewardShell.compose.targetSteward']}」（实测「${dismissed && dismissed.chip}」）`);

  // 追加一个字再触发一轮预判——撤掉的这次不该自己复活（哪怕命中条件仍然成立）。
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    input.value = input.value + '喔';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(600);   // 150ms 去抖 + 一次同机 /api/steward/preroute 往返，600ms 给足冗余
  const stillDismissed = await cdp.evaluate(FEED);
  ok(stillDismissed.chip === zh['stewardShell.compose.targetSteward'],
    `D3-4 撤掉之后追加输入，预判不会自己回来（实测「${stillDismissed.chip}」）`);

  // 清空输入框 = 用户在打一句新的话——这次否掉的状态该复位，预判正常回来。注意：这里【不能】用
  // 「等 chip 变回『如意』」来判定复位是否完了——chip 因为 D3-3 已经是「如意」了，那个 waitForEval
  // 会在第一次检查就通过、完全没等到清空这一路的去抖（150ms）真的跑完；真要复位的是 hintDismissed
  // 这个状态位（不反映在 chip 文案上），所以老老实实睡够一个去抖窗口 + 余量，再打下一句话。
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    input.focus();
    input.value = ${JSON.stringify(LONG_TITLE + '，再帮我瞧一瞧这条')};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const revived = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return snapshot.chip === ${JSON.stringify(longHintCopy)} ? snapshot : null;
  })()`);
  ok(Boolean(revived), `D3-5 清空输入框、重打一句新的话之后，预判正常回来（实测「${revived && revived.chip}」）`);

  // 收尾：清空输入框，不给后面的分组断言留任何残留文本。
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitForEval(cdp, `(() => (${FEED}).chip === ${JSON.stringify(zh['stewardShell.compose.targetSteward'])} ? true : null)()`);

  // ─── 117l-B2 ④：多轮之后的对话流长什么样（用户第五轮走查 4）─────────────────────
  // 到这儿剧本已经积了好几轮管家的话（到访问候 ＋ 每一轮的回复 ＋ 撤回后那句「那递给谁？」），
  // 正是用户抱怨的那个形状：修前左边是一列 8px 灰点，且每一行的按钮都一样重。
  const grouped = await cdp.evaluate(FEED);
  const ruyiRows = (grouped && grouped.ruyiRows) || [];
  ok(ruyiRows.length >= 3, `R1 剧本跑到这里至少有三条管家消息（实测 ${ruyiRows.length} 条）`);
  ok(ruyiRows.length >= 3 && ruyiRows.filter(row => row.hasAvatar).length === 1
    && ruyiRows[ruyiRows.length - 1].hasAvatar === true,
    'R2 只有【最后一行】有真头像（其余行的槽是空的）');
  ok(ruyiRows.length >= 3 && ruyiRows.slice(0, -1).every(row => row.stale === true)
    && ruyiRows[ruyiRows.length - 1].stale === false,
    'R3 除最新那一条之外全部 .is-stale（判据＝头像在谁那儿，markStale 一处维护）');
  ok(ruyiRows.length >= 3 && ruyiRows[0].groupStart === true,
    'R4 第一行是组首（.is-group-start）');
  // 撤回之后那两行是连着的两条管家消息（「已经递给…」＋「那递给谁？」），它们该是【同一组】：
  // 倒数第二行是组首、最后一行不是组首但是组尾。这就是「连发多条管家消息成组」的真实证据。
  const tail = ruyiRows.slice(-2);
  ok(tail.length === 2 && tail[0].groupStart === true && tail[0].groupEnd === false
    && tail[1].groupStart === false && tail[1].groupEnd === true,
    `R5 撤回后那两条连着的管家消息成【一组】（组首/组尾各一，实测 ${JSON.stringify(tail.map(r => [r.groupStart, r.groupEnd]))}）`);
  ok(ruyiRows.every(row => row.slotMark === 'none'),
    `R6 空槽不再画那个 8px 灰点（用户说的「边边那个点」；实测 ${JSON.stringify([...new Set(ruyiRows.map(r => r.slotMark))])}）`);
  // 左侧那道竖线的三条规矩，按【实际算出来的组】逐行核对，不写死行号：
  //   · 单行成组 → 不画（否则又变成「每一行左边一个记号」，正是用户抱怨的那个形状）；
  //   · 头像所在的【最新那一组】→ 不画（头像本身就是锚）；
  //   · 其余的多行组 → 组里每一行都画（各画一段、非组尾那几段向下多探一个 gap，接成一条）。
  const groups = [];
  for (const row of ruyiRows) {
    if (row.groupStart || !groups.length) groups.push([]);
    groups[groups.length - 1].push(row);
  }
  const lastGroup = groups[groups.length - 1] || [];
  const lineVerdict = groups.map(group => {
    const shouldDraw = group.length >= 2 && group !== lastGroup;
    return group.every(row => row.groupLine === shouldDraw) ? 'ok' : `bad(len=${group.length},draw=${shouldDraw})`;
  });
  ok(groups.length >= 3 && groups.some(group => group.length >= 2 && group !== lastGroup)
    && lineVerdict.every(verdict => verdict === 'ok'),
    `R7 竖线只画给「多行且不是头像所在那一组」的组（${groups.length} 组，逐组核对 ${JSON.stringify(lineVerdict)}）`);
  ok(lastGroup.length >= 2 && lastGroup.every(row => row.groupLine === false),
    `R7b companion：头像所在的最新那一组【整组】不画（它有 ${lastGroup.length} 行，是多行组，只因为有头像才不画）`);
  const staleWithActs = ruyiRows.filter(row => row.stale && row.acts > 0);
  ok(staleWithActs.length > 0
    && staleWithActs.every(row => /rgba\(0, 0, 0, 0\)|transparent/.test(row.actBg))
    && staleWithActs.every(row => row.disabledActs === 0),
    `R8 旧行的按钮降成幽灵档（底色透明）但【仍然可点】（零 disabled；实测 ${staleWithActs.length} 行，底色 ${JSON.stringify([...new Set(staleWithActs.map(r => r.actBg))])}）`);

  // ─── 117s-C（用户第九轮走查⑦「管家交互界面优化…输出要支持 markdown、制图」）───────────────
  // 修前 steward-conversation.js 的纪律是「零 innerHTML，全部 textContent」，模型写的 `## 结论先行`
  // 与 `**偏空**` 原样上屏（用户截图 2、4）。现在管家的 say 经【注入的】共享渲染器上屏 ——
  // 与经典壳六个消费面同一份 renderMarkdownInto ＋ highlightIn（后者就是用户说的「制图显示」）。
  // 先烧掉一格剧本序号，再问真正要断言的那一句。为什么要这一步：FAKE_REPLY_SEQUENCE 是按【流式
  // 请求序】取的，而剧本第 5 条（'好的，我接着做。'，本来给递话之后那条线程自己的回合用）在本件
  // 的真实时序里【不一定】被消费——递话随后就被撤回了。烧一格之后无论那一条有没有被人用掉，
  // 本用例拿到的都是末条（超出即钳到末条）：没被用掉→这一发吃掉它，下一发是 MD；被用掉了→
  // 这一发就是 MD，下一发钳住还是 MD。两条路都落在 markdown 那一条上。
  const beforeBurn = await cdp.evaluate(FEED);
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    input.focus();
    input.value = '嗯';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return (snapshot.typing === 0 && snapshot.rows >= ${beforeBurn.rows} + 2) ? snapshot : null;
  })()`, 600);
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    input.focus();
    input.value = '说说你的看法';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  // 先等这一回合的话上屏（终态那一次才带高亮／mermaid，所以判据取 say 的正文）。
  const arrived = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    // 判据带上 ※ 浮层：say 是【流式】上屏的，只看正文会等到「刚流到一半」那一瞬间的快照；
    // 浮层是 finishReply 里紧挨着终态渲染那一行加的，它在＝这一回合真的收尾了。
    return (snapshot.lastSay && snapshot.lastSay.text.indexOf('结论先行') >= 0 && snapshot.lastWhy) ? snapshot : null;
  })()`, 300);
  const shot = arrived || await cdp.evaluate(FEED);
  ok(Boolean(arrived),
    `S0 管家那条 markdown 回复上屏了（实测最后一条话「${((shot.lastSay && shot.lastSay.text) || '').slice(0, 80)}」，`
    + `全部 says ${JSON.stringify((shot.says || []).slice(-3))}）`);
  // mermaid 容器是 highlightIn 里【异步】补上的（renderMermaidBlocks 的 ensureWrapper 在 vendor
  // 加载之前就把 .mermaid-block 框好了），所以它单独再等一次。
  const markdown = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return (snapshot.lastSay && snapshot.lastSay.mermaidBlocks >= 1) ? snapshot : null;
  })()`, 150) || arrived;
  const md = markdown ? markdown.lastSay : null;
  ok(Boolean(md) && md.md === true && md.h2 >= 1 && md.strong >= 1 && md.li >= 3 && md.preCode >= 2,
    `S1 markdown 真的成了 DOM：h2/strong/li/pre>code 各就各位（实测 ${JSON.stringify(md && {
      md: md.md, h2: md.h2, strong: md.strong, li: md.li, preCode: md.preCode })}）`);
  ok(Boolean(md) && md.mermaidBlocks >= 1,
    `S2 mermaid 围栏拿到了图表容器 .mermaid-block（vendor 里没有 mermaid.min.js 时它退化成「原代码块 + 一行提示」，`
    + `容器仍在——这一条钉的正是「制图这条路真的接上了」；实测 ${md && md.mermaidBlocks} 个）`);
  ok(Boolean(md) && md.scripts === 0 && md.onerrorAttrs === 0 && md.rawHasOnerror === false,
    `S3 注入被净化：零 script 元素、零 onerror 属性、最终 DOM 里连 onerror 这几个字符都不剩`
    + `（实测 script ${md && md.scripts} / onerror属性 ${md && md.onerrorAttrs} / 源码里还有 onerror: ${md && md.rawHasOnerror}）`);
  ok(Boolean(md) && md.whiteSpace === 'normal',
    `S3b 样式层跟上了：markdown 一来 white-space 就从 pre-wrap 退场（否则块与块之间那些结构性换行`
    + ` 会被画成一片真空行；实测「${md && md.whiteSpace}」）`);
  ok(Boolean(md) && md.whyInTail === true,
    'S3c ※ 仍然挂在句尾那一段里（markdown 之后它若掉出段落就会自己占一行）');
  const mdWhy = markdown ? markdown.lastWhy : null;
  ok(Boolean(mdWhy) && mdWhy.headings === 0 && mdWhy.lines.some(line => line.indexOf('##') === 0),
    `S4 ※ 里的依据【不】走渲染器：井号原样在，浮层里零 h1/h2/h3/strong/li（它是机器回执，`
    + `被 markdown 吃掉就变形了；实测 ${JSON.stringify(mdWhy)}）`);
  // 截图为证（§11.13 验收 D5「真浏览器截图」）。写进一个自己建的固定目录，不依赖任何人的临时路径；
  // 拍不下来也绝不影响断言（它是证据，不是判据）。
  const shotDirC = path.join(os.tmpdir(), 'ruyi-117s-C-shots');
  const shoot = async name => {
    try {
      fs.mkdirSync(shotDirC, { recursive: true });
      const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shotDirC, name), Buffer.from(png.data, 'base64'));
      console.log(`  截图：${path.join(shotDirC, name)}`);
    } catch { /* 证据拍不下来不改变判定 */ }
  };
  await shoot('117s-C-markdown.png');
  // 117s-H：本刀的证据另写一个目录（与 C 刀那批分开，便于逐刀回看）。
  const shotDirH = path.join(os.tmpdir(), 'ruyi-117s-H-shots');
  const shootH = async name => {
    try {
      fs.mkdirSync(shotDirH, { recursive: true });
      const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shotDirH, name), Buffer.from(png.data, 'base64'));
      console.log(`  截图：${path.join(shotDirH, name)}`);
    } catch { /* 证据拍不下来不改变判定 */ }
  };

  // ─── 117s-C：来源小头「来自线程『X』」（用户第九轮走查⑦「返回消息没有区分」）──────────────
  // 收件箱触发的回合要走真实的线程收工事件才跑得起来（后端 5 秒去抖 + 事件队列），本件的剧本
  // 序号经不起那一下抖动。所以这里用【同一个模块的公开 API】把那条历史重放一遍：新建一个
  // conversation 实例（注入一个只回固定 JSON 的假 api），调它的 appendSince —— 走的是收件箱回复
  // 进对话流的那条真路径（steward-shell 的状态轮询发现 trigger==='inbox' 时调的就是它）。
  // 这个实例【没有】注入渲染器，于是它顺带钉住了另一半：缺席时全线回落 textContent。
  const chipCase = await cdp.evaluate(`(async () => {
    const mod = await import('/js/steward-conversation.js');
    window.__ruyiFocused = [];
    document.addEventListener(mod.STEWARD_FOCUS_THREAD_EVENT, event => {
      window.__ruyiFocused.push(String((event.detail && event.detail.sessionId) || ''));
    });
    const inbox = '[收件箱] 这是工作台的 1 条系统事件 - [1] thread_done · 线程「' + ${JSON.stringify(THREAD_TITLE)} + '」(' + ${JSON.stringify(threadId)} + ') · 收工了';
    const payload = { session: { messages: [
      { role: 'user', createdAt: '2099-01-01T00:00:00.000Z', meta: { origin: 'inbox' }, content: inbox },
      { role: 'assistant', createdAt: '2099-01-01T00:00:01.000Z', content: '',
        steward: { trigger: 'inbox', say: '那条线程收工了。', why: '', acts: [], actions: [] } },
      { role: 'user', createdAt: '2099-01-01T00:00:02.000Z', content: '那我自己问一句' },
      { role: 'assistant', createdAt: '2099-01-01T00:00:03.000Z', content: '',
        steward: { trigger: 'user', say: '这句是你自己问的。', why: '', acts: [], actions: [] } },
    ] } };
    const conv = mod.createStewardConversation({
      api: async () => payload,
      t: (key, params) => key + ((params && params.title) ? '|' + params.title : ''),
      isStewardMode: () => true,
    });
    return { rendered: await conv.appendSince('2000-01-01T00:00:00.000Z') };
  })()`);
  ok(Boolean(chipCase) && chipCase.rendered === 3,
    `T0 三条上屏（收件箱那条系统消息不冒充用户气泡，老纪律不动；实测 ${chipCase && chipCase.rendered}）`);
  const chipSnapshot = await cdp.evaluate(FEED);
  await shoot('117s-C-source-chip.png');
  const sources = chipSnapshot.sources || [];
  ok(sources.length === 1,
    `T1 只有【收件箱触发】的那条回复带来源小头，用户自己问的那条不带（实测 ${sources.length} 枚）`);
  ok(sources.length === 1 && sources[0].sessionId === threadId,
    `T2 小头指向事件里那条线程的 sessionId（实测「${sources[0] && sources[0].sessionId}」，应为「${threadId}」）`);
  ok(sources.length === 1 && sources[0].text.indexOf(THREAD_TITLE) >= 0
    && sources[0].text.indexOf('stewardShell.chat.fromThread') === 0,
    `T3 小头念的是线程【显示名】而不是 id（实测「${sources[0] && sources[0].text}」）`);
  ok(sources.length === 1 && sources[0].beforeSay === true,
    'T4 小头在话的【上面】（先说这是哪条线程，再说话）');
  const focused = await cdp.evaluate(`(() => {
    const chip = document.querySelector('#stewardFeed .steward-source');
    if (chip) chip.click();
    return (window.__ruyiFocused || []).slice();
  })()`);
  ok(Array.isArray(focused) && focused.includes(threadId),
    `T5 点小头派发 steward:focus-thread，带的是那条线程的 id（实测 ${JSON.stringify(focused)}）`);
  ok(Boolean(chipSnapshot.lastSay) && chipSnapshot.lastSay.md === false
    && chipSnapshot.lastSay.text.indexOf('这句是你自己问的。') === 0,
    `T6 没有注入渲染器的实例全线回落 textContent（缺席那条路真的走得通；实测 md=${chipSnapshot.lastSay && chipSnapshot.lastSay.md}）`);


  // ─── 117s-H2 交付卡（27 号文 §11.13.3 H2；用户第三轮回话「线程的交付管家能不能看全」）────────
  // 摸底结论是「管家读了、时机也对，但用户看到的是二手货」：say 硬切 600 字，2687 字的交付被压成
  // 407 字。所以收件箱触发的那条回复里，线程【自己】的交付原文嵌在同一张卡里，管家的话退成上面
  // 的一两句按语。这一段用与 T 段同样的手法重放：新建实例、注入一个按 URL 分流的假 api ——
  // 走的是 appendSince 那条真路径（收件箱回复进对话流的唯一入口），零新增路由（GET /api/sessions/<id>
  // 是 13d 的既有信封，session.messages 就是整份消息）。
  const DELIVERABLE_MD = [
    '## 结论',
    '',
    '今天这条线的结论是**偏空**，理由三条：',
    '',
    '- 成交额连续两日缩量',
    '- 涨停家数腰斩',
    '- 北向资金净流出',
    '',
    '| 指标 | 今日 | 昨日 |',
    '| --- | --- | --- |',
    '| 成交额 | 1.2 万亿 | 1.5 万亿 |',
    '| 涨停数 | 31 | 44 |',
    '',
    '完整快照已落盘到当天的日志里。',
  ].join('\n');
  const DELIVER_THREAD = 'sess_deliver_1';
  // 交付卡快照：只看【本段新追加的那几行】（上面 T 段的行还在 feed 里，不切一刀会数混）。
  const DELIVER = `(() => {
    const feed = document.getElementById('stewardFeed');
    const rows = [...feed.querySelectorAll('.steward-msg')].slice(window.__ruyiDeliverFrom || 0);
    const blocks = rows.map(row => row.querySelector('.steward-deliverable')).filter(Boolean);
    const block = blocks[0] || null;
    const body = block ? block.querySelector('.steward-deliverable-body') : null;
    const row = block ? block.closest('.steward-msg') : null;
    const chip = row ? row.querySelector('.steward-source') : null;
    const pop = row ? row.querySelector('.steward-why-pop') : null;
    return {
      rows: rows.length,
      blocks: blocks.length,
      head: block ? block.querySelector('.steward-deliverable-head').textContent : '',
      sessionId: block ? (block.dataset.sessionId || '') : '',
      md: body ? body.classList.contains('md') : false,
      h2: body ? body.querySelectorAll('h2').length : 0,
      li: body ? body.querySelectorAll('li').length : 0,
      table: body ? body.querySelectorAll('table').length : 0,
      text: body ? body.textContent : '',
      clamped: body ? body.classList.contains('is-clamped') : false,
      overflowing: body ? (body.scrollHeight > body.clientHeight + 2) : false,
      acts: block ? [...block.querySelectorAll('.steward-deliverable-acts button')].map(node => node.textContent) : [],
      // 版面次序：来源小头 → 管家的按语 → 交付卡（按语在卡【上面】，卡不抢开场白）。
      sayAbove: Boolean(block && block.previousElementSibling
        && block.previousElementSibling.classList.contains('steward-say')),
      chipFirst: Boolean(chip && chip.nextElementSibling && chip.nextElementSibling.classList.contains('steward-say')),
      // ※ 浮层仍然是纯文本（它是机器回执，被 markdown 吃掉就变形）。
      whyMarkup: pop ? pop.querySelectorAll('h1, h2, h3, strong, li').length : -1,
      // 用户自己问的那条【一个交付卡都没有】。
      ruyiBlocks: rows.filter(node => node.classList.contains('steward-msg-ruyi'))
        .map(node => node.querySelectorAll('.steward-deliverable').length),
    };
  })()`;
  // 三个用例共用的一段：造一个只认两条 URL 的假 api（历史 / 那条线程的信封）。
  const deliverRig = `(async (options) => {
    const mod = await import('/js/steward-conversation.js');
    const prims = (await import('/js/chat-render-primitives.js')).createChatRenderPrimitives({
      el: (tag, cls, text) => {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
      },
      escapeHtml: value => String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])),
      // marked 是【依赖注入】的（组合根从 vendor 的全局拿），不是模块内的全局引用 —— 不喂它，
      // renderMarkdown 会安静地退化成一个 <div class="plain">，md 类还在但一个 h2 都没有。
      marked: window.marked,
      t: key => key,
      toast: () => {},
    });
    window.__ruyiDeliverFrom = document.querySelectorAll('#stewardFeed .steward-msg').length;
    window.__ruyiClassic = [];
    window.__ruyiCalls = [];
    const thread = { ok: true, session: { id: options.threadId, messages: [
      { role: 'user', turnSeq: 1, createdAt: '2099-01-01T00:00:00.000Z', content: '第一回合的问题' },
      { role: 'assistant', turnSeq: 1, createdAt: '2099-01-01T00:00:01.000Z', content: '第一回合的旧答案（不是这次的交付）' },
      { role: 'user', turnSeq: 2, createdAt: '2099-01-01T00:00:02.000Z', content: '第二回合的问题' },
      { role: 'assistant', turnSeq: 2, createdAt: '2099-01-01T00:00:03.000Z', content: '第二回合的旧答案（不是这次的交付）' },
      { role: 'user', turnSeq: 3, createdAt: '2099-01-01T00:00:04.000Z', content: '第三回合的问题' },
      { role: 'assistant', turnSeq: 3, createdAt: '2099-01-01T00:00:05.000Z', content: options.deliverable },
    ] } };
    const history = { session: { messages: options.messages } };
    const conv = mod.createStewardConversation({
      api: async url => {
        window.__ruyiCalls.push(String(url));
        if (String(url).indexOf('/api/sessions/steward') === 0) return history;
        if (options.failThread) throw new Error('boom');
        return thread;
      },
      t: (key, params) => key
        + ((params && params.title) ? '|' + params.title : '')
        + ((params && params.seq) ? '|' + params.seq : ''),
      isStewardMode: () => true,
      renderMarkdownInto: prims.renderMarkdownInto,
      highlightIn: prims.highlightIn,
      openClassicWindow: async id => { window.__ruyiClassic.push(String(id)); return id; },
    });
    const rendered = await conv.appendSince('2000-01-01T00:00:00.000Z');
    return { rendered, calls: window.__ruyiCalls.slice() };
  })`;
  // 用例 A：老回合（trigger 是 'inbox' 字符串），来源与回合号都从中文事件行里抠。
  const deliverA = await cdp.evaluate(`${deliverRig}({
    threadId: ${JSON.stringify(DELIVER_THREAD)},
    deliverable: ${JSON.stringify(DELIVERABLE_MD)},
    messages: [
      { role: 'user', createdAt: '2099-02-01T00:00:00.000Z', meta: { origin: 'inbox' },
        content: '[收件箱] 这是工作台的 1 条系统事件 - [2] done · 线程「A股每日分析」(${DELIVER_THREAD}) · 线程第 3 回合跑完了' },
      { role: 'assistant', createdAt: '2099-02-01T00:00:01.000Z', content: '',
        steward: { trigger: 'inbox', say: '它收工了，结论偏空。原文见下。', why: '## 这一行是机器回执', acts: [], actions: [] } },
      { role: 'user', createdAt: '2099-02-01T00:00:02.000Z', content: '知道了' },
      { role: 'assistant', createdAt: '2099-02-01T00:00:03.000Z', content: '',
        steward: { trigger: 'user', say: '这句是你自己问的。', why: '', acts: [], actions: [] } },
    ],
  })`);
  const deliverShot = await waitForEval(cdp, `(() => {
    const snapshot = ${DELIVER};
    return (snapshot.blocks >= 1 && snapshot.md === true) ? snapshot : null;
  })()`, 300) || await cdp.evaluate(DELIVER);
  await shootH('117s-H-deliverable.png');
  ok(Boolean(deliverA) && deliverA.rendered === 3 && deliverShot.rows === 3
    && JSON.stringify(deliverShot.ruyiBlocks) === JSON.stringify([1, 0]),
    `U0 交付卡【只】长在收件箱触发的那条回复上，用户自己问的那条一个都没有（实测每行 ${JSON.stringify(deliverShot.ruyiBlocks)}）`);
  ok(deliverShot.sessionId === DELIVER_THREAD
    && deliverShot.head.indexOf('stewardShell.chat.deliverableHead') === 0 && deliverShot.head.indexOf('|3') > 0,
    `U1 卡头是「它交付的原文 · 第 N 回合」，N 取自事件行里的「线程第 3 回合」（实测「${deliverShot.head}」）`);
  ok(deliverShot.md === true && deliverShot.h2 >= 1 && deliverShot.li >= 3 && deliverShot.table === 1,
    `U2 交付原文走【同一条】渲染器成了 DOM：h2/li/table 各就各位（实测 ${JSON.stringify({
      md: deliverShot.md, h2: deliverShot.h2, li: deliverShot.li, table: deliverShot.table })}）`);
  ok(deliverShot.text.indexOf('第一回合的旧答案') < 0 && deliverShot.text.indexOf('偏空') >= 0,
    'U2b 挑的是【第 3 回合】那条助手话，不是整份会话里随便一条（旧回合的答案没混进来）');
  ok(deliverShot.clamped === true && deliverShot.overflowing === true
    && deliverShot.acts.length === 2 && deliverShot.acts[0] === 'stewardShell.chat.deliverableExpand'
    && deliverShot.acts[1] === 'stewardShell.drawer.fullText',
    `U3 默认折叠（真的被裁掉了一截）且「展开」「看全文」两枚都在（实测 ${JSON.stringify(deliverShot.acts)}，clamped=${deliverShot.clamped}）`);
  const expanded = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#stewardFeed .steward-msg')].slice(window.__ruyiDeliverFrom || 0);
    const more = rows.map(row => row.querySelector('.steward-deliverable-more')).filter(Boolean)[0];
    if (more) more.click();
    return ${DELIVER};
  })()`);
  ok(expanded.clamped === false && expanded.overflowing === false
    && expanded.acts[0] === 'stewardShell.chat.deliverableCollapse',
    `U4 点「展开」全文展开、按钮换成「收起」（实测 clamped=${expanded.clamped} / 溢出=${expanded.overflowing} / ${JSON.stringify(expanded.acts)}）`);
  ok(expanded.sayAbove === true && expanded.chipFirst === true,
    'U5 版面次序：来源小头 → 管家的按语 → 交付卡（管家的话在原件【上面】，只是一句按语）');
  const classicOpens = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#stewardFeed .steward-msg')].slice(window.__ruyiDeliverFrom || 0);
    const full = rows.map(row => row.querySelector('.steward-deliverable-full')).filter(Boolean)[0];
    if (full) full.click();
    return (window.__ruyiClassic || []).slice();
  })()`);
  ok(Array.isArray(classicOpens) && classicOpens.length === 1 && classicOpens[0] === DELIVER_THREAD,
    `U6 「看全文」走的是与抽屉同一个入口 openClassicWindow(sessionId)，带的是那条线程的 id（实测 ${JSON.stringify(classicOpens)}）`);
  ok(Array.isArray(deliverA.calls) && deliverA.calls.length === 2
    && deliverA.calls[0].indexOf('/api/sessions/steward?since=') === 0
    && deliverA.calls[1] === '/api/sessions/' + DELIVER_THREAD,
    `U7 取原文是【懒】的：两条管家回复只发了一发信封请求（收件箱那条），且走既有的 GET /api/sessions/<id>（实测 ${JSON.stringify(deliverA.calls)}）`);
  ok(deliverShot.whyMarkup === 0,
    `U8 ※ 浮层仍然零 h1/h2/strong/li —— 交付卡进了 markdown，机器回执没有（实测 ${deliverShot.whyMarkup}）`);

  // 用例 B（117s-H4）：新回合的 trigger 是对象 { kind, sessionId, title, turnSeq }。
  // 这一条【没有】收件箱系统消息，抠行法无从下手 —— 卡与小头都只能来自回执本身。
  const deliverB = await cdp.evaluate(`${deliverRig}({
    threadId: 'sess_stamped_2',
    deliverable: ${JSON.stringify(DELIVERABLE_MD)},
    messages: [
      { role: 'assistant', createdAt: '2099-03-01T00:00:00.000Z', content: '',
        steward: { trigger: { kind: 'inbox', sessionId: 'sess_stamped_2', title: '回执里的线程名', turnSeq: 2 },
          say: '它交了。', why: '', acts: [], actions: [] } },
    ],
  })`);
  const stamped = await waitForEval(cdp, `(() => {
    const snapshot = ${DELIVER};
    return (snapshot.blocks >= 1 && snapshot.text.length > 0) ? snapshot : null;
  })()`, 300) || await cdp.evaluate(DELIVER);
  const stampedChip = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#stewardFeed .steward-msg')].slice(window.__ruyiDeliverFrom || 0);
    const chip = rows.map(row => row.querySelector('.steward-source')).filter(Boolean)[0];
    return chip ? { text: chip.textContent, sessionId: chip.dataset.sessionId || '' } : null;
  })()`);
  ok(Boolean(deliverB) && deliverB.rendered === 1 && Boolean(stampedChip)
    && stampedChip.sessionId === 'sess_stamped_2' && stampedChip.text.indexOf('回执里的线程名') > 0,
    `U9 对象形状的 trigger：来源小头直接读回执里的 sessionId 与 title，不必再去抠中文事件行（实测 ${JSON.stringify(stampedChip)}）`);
  ok(stamped.blocks === 1 && stamped.sessionId === 'sess_stamped_2'
    && stamped.head.indexOf('|2') > 0 && stamped.text.indexOf('第二回合的旧答案') >= 0,
    `U9b 交付卡也认回执里的 turnSeq：钉的是第 2 回合那条助手话（实测卡头「${stamped.head}」）`);

  // 用例 C：信封取不到（网络断、会话被删）——一句兜底，回复本身照常上屏，绝不留空盒子、更不抛异常。
  const deliverC = await cdp.evaluate(`${deliverRig}({
    threadId: ${JSON.stringify(DELIVER_THREAD)},
    deliverable: ${JSON.stringify(DELIVERABLE_MD)},
    failThread: true,
    messages: [
      { role: 'user', createdAt: '2099-04-01T00:00:00.000Z', meta: { origin: 'inbox' },
        content: '[收件箱] 这是工作台的 1 条系统事件 - [9] done · 线程「取不到的那条」(${DELIVER_THREAD}) · 线程第 3 回合跑完了' },
      { role: 'assistant', createdAt: '2099-04-01T00:00:01.000Z', content: '',
        steward: { trigger: 'inbox', say: '它收工了。', why: '', acts: [], actions: [] } },
    ],
  })`);
  const failed = await waitForEval(cdp, `(() => {
    const snapshot = ${DELIVER};
    return (snapshot.blocks >= 1 && snapshot.text.length > 0) ? snapshot : null;
  })()`, 300) || await cdp.evaluate(DELIVER);
  ok(Boolean(deliverC) && deliverC.rendered === 1
    && failed.blocks === 1 && failed.text.indexOf('stewardShell.chat.deliverableMissing') === 0
    && failed.acts.length === 1 && failed.acts[0] === 'stewardShell.drawer.fullText',
    `U10 取不到原文时画一句兜底＋只留「看全文」，回复本身照常上屏（实测「${failed.text}」，按钮 ${JSON.stringify(failed.acts)}）`);
  await shootH('117s-H-deliverable-fallback.png');

  // ─── ⑥ 切回经典：无残留定时器 ────────────────────────────────────────────────
  await cdp.evaluate("document.getElementById('stewardClassicBtn').click(); true");
  const classic = await waitForEval(cdp, `(() => {
    const mode = document.documentElement.getAttribute('data-shell-mode');
    return mode === 'classic' ? ${FEED} : null;
  })()`);
  // 117j W2-5：三个管家计时器统一按 5s 下限起表（真要不要拉由每一拍自己判），
  // 所以「这是管家的计时器」的身份判据从 POLL_MS 重钉到 TICK_MS —— 不改的话本断言恒真、形同虚设。
  ok(Boolean(classic) && classic.intervals.filter(ms => ms === 5000).length === 0,
    'H1 回经典后管家状态轮询计时器被清');
  ok(Boolean(classic) && classic.intervals.filter(ms => ms === 1000).length <= (baseline ? baseline.thousand : 0),
    `H2 回经典后没有残留的撤回倒计时（1000ms 计时器不多于基线 ${baseline ? baseline.thousand : 0}）`);
  ok(Boolean(classic) && classic.avatarCount === 1,
    `H3 117j W2-3：回经典之后头像节点仍然只有一个、且还活着（clearFeed / 移除失败行之前都先 park 过；
        它一旦跟着某一行被销毁，presence 从此再也画不出来。实测 ${classic && classic.avatarCount} 个）`);
} catch (error) {
  console.log('ERROR ' + (error && error.stack || error));
  fail += 1;
} finally {
  if (fail && cdp && cdp.logs.length) {
    console.log('--- 浏览器控制台（最后 12 条，供归因）---');
    for (const line of cdp.logs.slice(-12)) console.log('  ' + line);
  }
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  killTree(fake);
  await sleep(300);
  stopRuyiTestBrowsers(profile);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* browser profile lock */ }
  console.log(`\nSTEWARD CONVERSATION E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
