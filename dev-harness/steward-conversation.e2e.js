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
  // F5b 重钉（32 号文 §2.2.2，用户对着这个现象确认了「对，就是这个」）：这一条原来钉的是
  // 「按钮上写着『撤回 N』」——而那正是用户指着说「显示有点问题」的东西：每秒把整段文字换一遍，
  // 位数从两位掉到一位时按钮宽度跟着跳。秒数改画成环之后，可证伪的事实反过来了：
  // **按钮的字恒是「撤回」，一个数字都不许出现在文字里**。环怎么走、宽度跳不跳，由本件末尾
  // Z 段逐秒采样真机实测（这里只花一次快照的钱，不占用那 10 秒窄窗）。
  ok(undoLabel === zh['stewardShell.chat.undo'] && !/\d/.test(String(undoLabel)),
    `F4 回执按钮的文字恒是「撤回」，秒数不写进文字（实测 ${JSON.stringify(undoLabel)}）`);
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

  // ─── F1 线程卡 ＋ F4 回复定型（27 号文 §11.13.1「线程即频道」；设计稿两块画板）─────────────
  // 同一条线程连着的几条管家的话合成【一张卡】（3px 色条 ＋ 一行卡头：线程名 · 五态 · 最后动静 ·
  // 模型 · 打开）；管家【本人】说的话没有色条、没有卡。四色按首次出现顺序循环，同一条线程恒用同一色。
  // 回复定型：首句抬成引子（只加类，不改一个字），正文超 8 行折起来（与交付卡同一处折叠实现）。
  // 手法与 T/U 两段一样：新建实例 ＋ 注入按 URL 分流的假 api，走 appendSince 那条真路径。
  const THREAD_A = 'sess_v_alpha';
  const THREAD_B = 'sess_v_beta';
  // 纯文本（不带 markdown 记号）的长回复：这样「DOM 里的字和模型说的字一模一样」才验得干净。
  const LEAD_SAY = [
    '偏空，但不是崩。',
    '今天最可能的剧本是贴着均价阴跌、尾盘定方向。',
    '不是它一家的事：整个板块集体退潮。',
    '数据是盘中快照，收盘前还会变。',
    '主力资金连续两日净流出。',
    '涨停家数腰斩。',
    '北向资金今天也是净卖。',
    '成交额比昨天少了三成。',
    '要不要现在动手，你说了算。',
    '我这边随时可以再跑一次。',
  ].join('\n\n');
  const THREAD_SHOT = `(() => {
    const feed = document.getElementById('stewardFeed');
    const rows = [...feed.querySelectorAll('.steward-msg')].slice(window.__ruyiThreadFrom || 0);
    const readHead = row => {
      const head = row.querySelector('.steward-thread-head');
      if (!head) return null;
      const state = head.querySelector('.steward-thread-state');
      const meta = head.querySelector('.steward-thread-meta');
      return {
        name: head.querySelector('.steward-thread-name').textContent,
        state: state.hidden ? '' : state.textContent,
        stateAttr: state.dataset.state || '',
        meta: meta.hidden ? '' : meta.textContent,
        opens: head.querySelectorAll('.steward-thread-open').length,
      };
    };
    return {
      rows: rows.length,
      ruyi: rows.filter(row => row.classList.contains('steward-msg-ruyi')).map(row => {
        const say = row.querySelector('.steward-say');
        const lead = say ? say.querySelector('.is-lead') : null;
        return {
          thread: row.dataset.thread || '',
          hue: row.dataset.threadHue || '',
          isThread: row.classList.contains('is-thread'),
          start: row.classList.contains('is-thread-start'),
          end: row.classList.contains('is-thread-end'),
          // 色条与组竖线各自画没画（都走计算样式，不碰任何私有状态）。
          stripe: getComputedStyle(row, '::after').content !== 'none',
          stripeColor: getComputedStyle(row, '::after').backgroundColor,
          groupLine: getComputedStyle(row, '::before').content !== 'none',
          heads: row.querySelectorAll('.steward-thread-head').length,
          head: readHead(row),
          sources: row.querySelectorAll('.steward-source').length,
          sourceShown: (() => {
            const chip = row.querySelector('.steward-source');
            return chip ? getComputedStyle(chip).display !== 'none' : false;
          })(),
          deliverables: row.querySelectorAll('.steward-deliverable').length,
          sayText: say ? say.textContent : '',
          leads: say ? say.querySelectorAll('.is-lead').length : 0,
          leadTag: lead ? lead.tagName : '',
          leadWeight: lead ? getComputedStyle(lead).fontWeight : '',
          clamped: say ? say.classList.contains('is-clamped') : false,
          sayCut: say ? (say.scrollHeight > say.clientHeight + 2) : false,
          sayActs: [...row.querySelectorAll('.steward-say-acts button')].map(node => node.textContent),
        };
      }),
    };
  })()`;
  const threadRun = await cdp.evaluate(`(async () => {
    const mod = await import('/js/steward-conversation.js');
    const prims = (await import('/js/chat-render-primitives.js')).createChatRenderPrimitives({
      el: (tag, cls, text) => {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
      },
      escapeHtml: value => String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])),
      marked: window.marked,
      t: key => key,
      toast: () => {},
    });
    window.__ruyiThreadFrom = document.querySelectorAll('#stewardFeed .steward-msg').length;
    const touched = new Date(Date.now() - 20000).toISOString();
    const threadSession = (id, title, extra, seqs) => ({
      ok: true, displayTitle: title, ...extra,
      session: {
        id, turnSeq: seqs[seqs.length - 1], updatedAt: touched,
        engineRoute: { engine: 'openai', providerId: 'fake', model: id === ${JSON.stringify(THREAD_A)} ? 'qwen3.8-flash' : 'gpt-5-mini' },
        messages: seqs.flatMap(seq => ([
          { role: 'user', turnSeq: seq, createdAt: '2099-05-01T00:00:00.000Z', content: '第 ' + seq + ' 回合的问题' },
          { role: 'assistant', turnSeq: seq, createdAt: '2099-05-01T00:00:01.000Z', content: ${JSON.stringify(DELIVERABLE_MD)} },
        ])),
      },
    });
    const envelopes = {
      [${JSON.stringify(THREAD_A)}]: threadSession(${JSON.stringify(THREAD_A)}, '博纳影业怎么看', { resumable: { live: true } }, [3, 4, 5]),
      [${JSON.stringify(THREAD_B)}]: threadSession(${JSON.stringify(THREAD_B)}, '大A接下来的走势', { relay: { channel: 'permission' } }, [2]),
    };
    const inbox = (id, title, seq) => ({ kind: 'inbox', sessionId: id, title, turnSeq: seq });
    const history = { session: { messages: [
      { role: 'assistant', createdAt: '2099-05-02T00:00:00.000Z', content: '',
        steward: { trigger: inbox(${JSON.stringify(THREAD_A)}, '博纳影业怎么看', 3), say: '它交了第三回合。', why: '', acts: [], actions: [] } },
      { role: 'assistant', createdAt: '2099-05-02T00:00:01.000Z', content: '',
        steward: { trigger: inbox(${JSON.stringify(THREAD_A)}, '博纳影业怎么看', 4), say: '第四回合也交了。', why: '', acts: [], actions: [] } },
      { role: 'assistant', createdAt: '2099-05-02T00:00:02.000Z', content: '',
        steward: { trigger: inbox(${JSON.stringify(THREAD_B)}, '大A接下来的走势', 2), say: '这条在等你拿主意。', why: '', acts: [], actions: [] } },
      { role: 'user', createdAt: '2099-05-02T00:00:03.000Z', content: '知道了' },
      { role: 'assistant', createdAt: '2099-05-02T00:00:04.000Z', content: '',
        steward: { trigger: 'user', say: ${JSON.stringify(LEAD_SAY)}, why: '', acts: [], actions: [] } },
      { role: 'assistant', createdAt: '2099-05-02T00:00:05.000Z', content: '',
        steward: { trigger: inbox(${JSON.stringify(THREAD_A)}, '博纳影业怎么看', 5), say: '第五回合又交了。', why: '', acts: [], actions: [] } },
    ] } };
    window.__ruyiThreadCalls = [];
    const conv = mod.createStewardConversation({
      api: async url => {
        window.__ruyiThreadCalls.push(String(url));
        const path = String(url).split('?')[0];
        if (path === '/api/sessions/steward') return history;
        const id = path.replace('/api/sessions/', '');
        return envelopes[id] || null;
      },
      t: (key, params) => key + ((params && params.title) ? '|' + params.title : '') + ((params && params.seq) ? '|' + params.seq : ''),
      isStewardMode: () => true,
      renderMarkdownInto: prims.renderMarkdownInto,
      highlightIn: prims.highlightIn,
    });
    const rendered = await conv.appendSince('2000-01-01T00:00:00.000Z');
    return { rendered, calls: window.__ruyiThreadCalls.slice() };
  })()`);
  // 卡头的事实是异步填的（与交付卡 await 同一个 promise），所以等到药丸真的亮出来为止。
  const cards = await waitForEval(cdp, `(() => {
    const snapshot = ${THREAD_SHOT};
    const heads = snapshot.ruyi.filter(row => row.head);
    return (heads.length === 3 && heads.every(row => row.head.state)) ? snapshot : null;
  })()`, 300) || await cdp.evaluate(THREAD_SHOT);
  const shotDirF = path.join(os.tmpdir(), 'ruyi-F1F4-shots');
  const shootF = async name => {
    try {
      fs.mkdirSync(shotDirF, { recursive: true });
      const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shotDirF, name), Buffer.from(png.data, 'base64'));
      console.log(`  截图：${path.join(shotDirF, name)}`);
    } catch { /* 证据拍不下来不改变判定 */ }
  };
  await shootF('F1-thread-cards.png');
  // 第二张证据：滚到第二条线程那一段 —— 一屏里同时看得见【两种颜色的色条】与【折起来的正文】
  // （这一张要在点「展开」之前拍，展开之后就不是折叠态了）。
  await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#stewardFeed .steward-msg')].slice(window.__ruyiThreadFrom || 0);
    const beta = rows.filter(row => row.dataset.thread === ${JSON.stringify(THREAD_B)})[0];
    if (beta && beta.scrollIntoView) beta.scrollIntoView({ block: 'start' });
    return true;
  })()`);
  await shootF('F1-two-threads-and-clamp.png');
  const cardRows = (cards && cards.ruyi) || [];
  ok(Boolean(threadRun) && threadRun.rendered === 6 && cardRows.length === 5,
    `V0 六条上屏（五条管家的话 ＋ 一条用户的话；实测 rendered=${threadRun && threadRun.rendered} / 管家行 ${cardRows.length}）`);
  const [a3, a4, b2, self, a5] = cardRows;
  ok(Boolean(a3) && Boolean(a4) && a3.thread === THREAD_A && a4.thread === THREAD_A
    && a3.start === true && a3.end === false && a4.start === false && a4.end === true
    && a3.heads + a4.heads === 1,
    `V1 连着的两条【同一线程】合成一张卡：一个卡头、组首组尾各一（实测 ${JSON.stringify([a3 && [a3.start, a3.end, a3.heads], a4 && [a4.start, a4.end, a4.heads]])}）`);
  ok(Boolean(b2) && b2.thread === THREAD_B && b2.start === true && b2.heads === 1
    && a3.hue !== b2.hue && a3.stripeColor !== b2.stripeColor
    && /^rgb/.test(String(a3.stripeColor)) && /^rgb/.test(String(b2.stripeColor)),
    `V2 两条不同线程＝两张卡，色条不是同一个颜色（实测 ${a3 && a3.stripeColor} ／ ${b2 && b2.stripeColor}）`);
  ok(Boolean(a5) && a5.thread === THREAD_A && a5.start === true
    && a5.hue === a3.hue && a5.stripeColor === a3.stripeColor,
    `V3 同一条线程隔了几条之后再出现，仍是同一个色（实测 ${a5 && a5.hue} vs ${a3 && a3.hue}，${a5 && a5.stripeColor}）`);
  ok(Boolean(self) && self.isThread === false && self.thread === '' && self.heads === 0
    && self.stripe === false && self.sources === 0,
    `V4 管家【本人】说的话没有色条、没有卡头、没有来源小头（实测 isThread=${self && self.isThread} / 色条=${self && self.stripe}）`);
  ok(cardRows.filter(row => row.isThread).every(row => row.stripe === true && row.groupLine === false),
    `V4b 一行只有一个锚：有色条的那几行不再画那道组竖线（实测 ${JSON.stringify(cardRows.map(row => [row.isThread, row.stripe, row.groupLine]))}）`);
  ok(Boolean(self) && self.clamped === true && self.sayCut === true
    && self.sayActs.length === 1 && self.sayActs[0] === 'stewardShell.chat.deliverableExpand',
    `V5 正文超 8 行默认折叠（真的被裁掉了一截）且带一枚「展开」（实测 clamped=${self && self.clamped} / 溢出=${self && self.sayCut} / ${JSON.stringify(self && self.sayActs)}）`);
  const expandedSay = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#stewardFeed .steward-msg')].slice(window.__ruyiThreadFrom || 0);
    const more = rows.map(row => row.querySelector('.steward-say-acts .steward-deliverable-more')).filter(Boolean)[0];
    if (more) more.click();
    return ${THREAD_SHOT};
  })()`);
  const selfOpen = (expandedSay && expandedSay.ruyi[3]) || null;
  ok(Boolean(selfOpen) && selfOpen.clamped === false && selfOpen.sayCut === false
    && selfOpen.sayActs[0] === 'stewardShell.chat.deliverableCollapse',
    `V5b 点「展开」全文展开、按钮换成「收起」——【与交付卡同一处折叠实现】（实测 clamped=${selfOpen && selfOpen.clamped} / ${JSON.stringify(selfOpen && selfOpen.sayActs)}）`);
  // 「首句抬成引子」是纯呈现：加粗的是第一个段落，而【一个字都没变】——把两边的空白去掉之后
  // DOM 里的字必须与模型说的那句话逐字相同（※ 是渲染层加的一枚按钮，不算正文，先摘掉）。
  const saidPlain = LEAD_SAY.replace(/\s+/g, '');
  const domPlain = String((selfOpen && selfOpen.sayText) || '').replace(/※/g, '').replace(/\s+/g, '');
  ok(Boolean(selfOpen) && selfOpen.leads === 1 && selfOpen.leadTag === 'P' && selfOpen.leadWeight === '600'
    && domPlain === saidPlain,
    `V6 首句抬成引子（第一个段落加粗）而正文逐字未变（引子 ${selfOpen && selfOpen.leadTag}/${selfOpen && selfOpen.leadWeight}，文字相同=${domPlain === saidPlain}）`);
  ok(Boolean(a3) && a3.deliverables === 1 && a3.sources === 1 && a3.sourceShown === false
    && Boolean(a3.head) && a3.head.opens === 1,
    `V7 117s-H 的交付卡与来源小头照旧长在卡里：小头仍在 DOM（它的聚焦通道没动），只是让位给卡头右端的「打开」（实测 交付卡 ${a3 && a3.deliverables} / 小头 ${a3 && a3.sources} / 可见 ${a3 && a3.sourceShown}）`);
  ok(Boolean(a3.head) && a3.head.name.indexOf('博纳影业怎么看') === 0
    && a3.head.stateAttr === 'running' && a3.head.state === 'mission.state.running'
    && a3.head.meta.indexOf(' · ') > 0 && a3.head.meta.indexOf('qwen3.8-flash') > 0,
    `V8 卡头的线程名/五态/最后动静/模型全部来自那一个信封（displayTitle、resumable.live、updatedAt、engineRoute.model；实测 ${JSON.stringify(a3.head)}）`);
  ok(Boolean(b2.head) && b2.head.stateAttr === 'needs_you' && b2.head.state === 'mission.state.needs_you'
    && b2.head.meta.indexOf('gpt-5-mini') > 0,
    `V8b 另一条线程的药丸走 relay.channel（13h 那条递话阶梯的输出）说「等你」，模型也是它自己那一份（实测 ${JSON.stringify(b2.head)}）`);
  // 本刀【零新增请求】：卡头没有自己的一发，它 await 的就是交付卡那一发（loadDeliverable 一处缓存，
  // 键仍是 117s-H2 定的 sessionId|turnSeq）。所以请求数完全由交付卡的既有行为决定 ——
  // 历史 1 发 ＋ A 的三个回合各 1 发 ＋ B 的一个回合 1 发 = 5 发，与本刀之前一模一样。
  ok(Array.isArray(threadRun.calls) && threadRun.calls.length === 5
    && threadRun.calls[0].indexOf('/api/sessions/steward?since=') === 0
    && threadRun.calls.filter(url => url === '/api/sessions/' + THREAD_A).length === 3
    && threadRun.calls.filter(url => url === '/api/sessions/' + THREAD_B).length === 1,
    `V9 卡头零新增请求：它与同一行的交付原文 await 同一个被缓存的 promise（实测 ${JSON.stringify(threadRun.calls)}）`);

  // ─── X F2 频道条（27 号文 §11.14；设计稿画板「宽屏 · 线程即频道」与「窄屏」）──────────────
  // 三条线程（甲乙丙）＋ 一条管家本人的话 ＋ 一句用户的话，走 enterVisit() 那条【真】路径：它自己
  // clearFeed（parkAvatar 先把头像送回头部，所以下面第 ⑥ 段的 avatarCount===1 不受影响），于是这一段
  // 的行计数不必再跟前面几段切一刀 —— feed 里就只有本段这 8 行。
  // 甲故意被乙、丙、管家本人隔开三次：点「只看甲」之后，四行必须重新合成【一张】卡（一个卡头、
  // 首尾各一），这是本刀最容易写错、也最该有断言的一处。
  const CH_A = 'sess_ch_alpha';
  const CH_B = 'sess_ch_beta';
  const CH_C = 'sess_ch_gamma';
  const CH_A_TITLE = '影视板块那件事';
  const CH_B_TITLE = '大盘怎么走';
  const CH_C_TITLE = '周报草稿';
  const CH_SELF_SAY = '这三条我都盯着，有动静我叫你。';
  const CHANNELS = `(() => {
    const feed = document.getElementById('stewardFeed');
    const bar = feed.querySelector('.steward-channels');
    const rows = [...feed.querySelectorAll('.steward-msg')];
    const shown = node => getComputedStyle(node).display !== 'none';
    const target = document.getElementById('stewardTarget');
    const board = document.getElementById('stewardBoard');
    const dotOf = node => {
      const dot = node.querySelector('.steward-channel-dot');
      return dot ? getComputedStyle(dot).backgroundColor : '';
    };
    return {
      bar: Boolean(bar),
      barFirst: Boolean(bar) && feed.firstElementChild === bar,
      barPosition: bar ? getComputedStyle(bar).position : '',
      barLive: bar ? (bar.getAttribute('aria-live') || '') : '',
      barRole: bar ? (bar.getAttribute('role') || '') : '',
      chips: bar ? [...bar.querySelectorAll('.steward-channel')].map(node => ({
        channel: node.dataset.channel || '',
        name: node.querySelector('.steward-channel-name').textContent,
        state: node.querySelector('.steward-channel-state')
          ? node.querySelector('.steward-channel-state').textContent : '',
        hue: node.getAttribute('data-thread-hue') || '',
        dots: node.querySelectorAll('.steward-channel-dot').length,
        dot: dotOf(node),
        on: node.classList.contains('is-on'),
        pressed: node.getAttribute('aria-pressed') || '',
      })) : [],
      boards: bar ? bar.querySelectorAll('.steward-channels-board').length : 0,
      // 「DOM 里一行都没少」：rows 数的是节点，shownRows 数的是【看得见】的那些。
      rows: rows.length,
      headNodes: feed.querySelectorAll('.steward-thread-head').length,
      shownRows: rows.filter(shown).map(row => row.dataset.thread
        || (row.classList.contains('steward-msg-user') ? 'user' : 'self')),
      hiddenRows: rows.filter(row => !shown(row)).length,
      shownHeads: rows.filter(shown)
        .reduce((sum, row) => sum + [...row.querySelectorAll('.steward-thread-head')].filter(shown).length, 0),
      // 可见的那几行线程段：[线程, 是不是段首, 是不是段尾]；一张卡 = 恰好一个 true 段首 + 一个 true 段尾。
      seams: rows.filter(row => shown(row) && row.classList.contains('is-thread'))
        .map(row => [row.dataset.thread, row.classList.contains('is-thread-start'), row.classList.contains('is-thread-end')]),
      target: target && target.querySelector('.steward-target-label')
        ? target.querySelector('.steward-target-label').textContent : '',
      boardOpen: Boolean(board) && board.hidden === false,
    };
  })()`;
  const channelRun = await cdp.evaluate(`(async () => {
    const mod = await import('/js/steward-conversation.js');
    const i18n = await import('/js/i18n.js');
    const prims = (await import('/js/chat-render-primitives.js')).createChatRenderPrimitives({
      el: (tag, cls, text) => {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
      },
      escapeHtml: value => String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])),
      marked: window.marked,
      t: key => key,
      toast: () => {},
    });
    const touched = new Date(Date.now() - 40000).toISOString();
    const envelope = (id, title, extra, seqs) => ({
      ok: true, displayTitle: title, ...extra,
      session: {
        id, turnSeq: seqs[seqs.length - 1], updatedAt: touched,
        engineRoute: { engine: 'openai', providerId: 'fake', model: 'gpt-5-mini' },
        messages: seqs.flatMap(seq => ([
          { role: 'user', turnSeq: seq, createdAt: '2099-06-01T00:00:00.000Z', content: '第 ' + seq + ' 回合的问题' },
          { role: 'assistant', turnSeq: seq, createdAt: '2099-06-01T00:00:01.000Z', content: '第 ' + seq + ' 回合的交付。' },
        ])),
      },
    });
    const envelopes = {
      [${JSON.stringify(CH_A)}]: envelope(${JSON.stringify(CH_A)}, ${JSON.stringify(CH_A_TITLE)}, { resumable: { live: true } }, [3, 4, 5, 6]),
      [${JSON.stringify(CH_B)}]: envelope(${JSON.stringify(CH_B)}, ${JSON.stringify(CH_B_TITLE)}, { relay: { channel: 'permission' } }, [2]),
      [${JSON.stringify(CH_C)}]: envelope(${JSON.stringify(CH_C)}, ${JSON.stringify(CH_C_TITLE)}, {}, [1]),
    };
    const inbox = (id, title, seq) => ({ kind: 'inbox', sessionId: id, title, turnSeq: seq });
    const said = (at, trigger, say) => ({ role: 'assistant', createdAt: at, content: '',
      steward: { trigger, say, why: '', acts: [], actions: [] } });
    const history = { session: { messages: [
      said('2099-06-02T00:00:00.000Z', inbox(${JSON.stringify(CH_A)}, ${JSON.stringify(CH_A_TITLE)}, 3), '甲交了第三回合。'),
      said('2099-06-02T00:00:01.000Z', inbox(${JSON.stringify(CH_B)}, ${JSON.stringify(CH_B_TITLE)}, 2), '乙这条在等你拿主意。'),
      said('2099-06-02T00:00:02.000Z', inbox(${JSON.stringify(CH_A)}, ${JSON.stringify(CH_A_TITLE)}, 4), '甲第四回合也交了。'),
      said('2099-06-02T00:00:03.000Z', inbox(${JSON.stringify(CH_A)}, ${JSON.stringify(CH_A_TITLE)}, 5), '甲第五回合又交了。'),
      said('2099-06-02T00:00:04.000Z', inbox(${JSON.stringify(CH_C)}, ${JSON.stringify(CH_C_TITLE)}, 1), '丙收工了。'),
      { role: 'user', createdAt: '2099-06-02T00:00:05.000Z', content: '知道了' },
      said('2099-06-02T00:00:06.000Z', 'user', ${JSON.stringify(CH_SELF_SAY)}),
      said('2099-06-02T00:00:07.000Z', inbox(${JSON.stringify(CH_A)}, ${JSON.stringify(CH_A_TITLE)}, 6), '甲第六回合。'),
    ] } };
    window.__ruyiChannelCalls = [];
    const conv = mod.createStewardConversation({
      api: async url => {
        window.__ruyiChannelCalls.push(String(url));
        const route = String(url).split('?')[0];
        if (route === '/api/steward/visit') return { ok: true, newVisit: false, pending: [], visit: { startedAt: '2000-01-01T00:00:00.000Z' } };
        if (route === '/api/sessions/steward') return history;
        return envelopes[route.replace('/api/sessions/', '')] || null;
      },
      state: { config: { stewardEnabledV1: true } },
      t: (key, params) => i18n.t(key, params || {}),
      isStewardMode: () => true,
      renderMarkdownInto: prims.renderMarkdownInto,
      highlightIn: prims.highlightIn,
    });
    const visit = await conv.enterVisit();
    return { ok: Boolean(visit), calls: window.__ruyiChannelCalls.slice() };
  })()`);
  // 卡头的事实是异步填的（与交付卡 await 同一个 promise），chip 上的状态又是从卡头读的 ——
  // 等到三枚线程 chip 都带上状态为止。
  const open = await waitForEval(cdp, `(() => {
    const snapshot = ${CHANNELS};
    const threads = snapshot.chips.filter(chip => chip.dots === 1);
    return (threads.length === 3 && threads.every(chip => chip.state)) ? snapshot : null;
  })()`, 400) || await cdp.evaluate(CHANNELS);
  const shotDirX = path.join(os.tmpdir(), 'ruyi-F2-shots');
  const shootX = async name => {
    try {
      fs.mkdirSync(shotDirX, { recursive: true });
      const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shotDirX, name), Buffer.from(png.data, 'base64'));
      console.log(`  截图：${path.join(shotDirX, name)}`);
    } catch { /* 证据拍不下来不改变判定 */ }
  };
  await cdp.evaluate(`(() => { const feed = document.getElementById('stewardFeed'); if (feed) feed.scrollTop = 0; return true; })()`);
  await shootX('F2-channels-all.png');
  const chipNames = (open.chips || []).map(chip => chip.name);
  ok(Boolean(channelRun) && channelRun.ok === true && open.bar === true && open.barFirst === true,
    `X0 频道条出现在对话流的最前面（实测 bar=${open.bar} / 第一个子节点=${open.barFirst}）`);
  ok(open.chips.length === 5
    && chipNames[0] === zh['stewardShell.channels.all']
    && chipNames[1] === CH_A_TITLE && chipNames[2] === CH_B_TITLE && chipNames[3] === CH_C_TITLE
    && chipNames[4] === zh['stewardShell.channels.steward']
    && open.boards === 1,
    `X1 三条线程 = 三枚 chip（按首次出现顺序）＋「全部」＋「管家本人」，右端一个「全部线程」入口（实测 ${JSON.stringify(chipNames)}）`);
  const threadChips = open.chips.filter(chip => chip.dots === 1);
  ok(threadChips.length === 3
    && threadChips.every(chip => /^rgb/.test(String(chip.dot)))
    && new Set(threadChips.map(chip => chip.dot)).size === 3
    && new Set(threadChips.map(chip => chip.hue)).size === 3,
    `X1b 只有线程 chip 有色点，三条三个色（色号抄自 F1 写在行上的 data-thread-hue；实测 ${JSON.stringify(threadChips.map(chip => [chip.hue, chip.dot]))}）`);
  ok(threadChips[0].state === zh['mission.state.running']
    && threadChips[1].state === zh['mission.state.needs_you']
    && threadChips[2].state === zh['mission.state.done'],
    `X1c chip 上的状态就是卡头那枚药丸的字（在跑／等你／已收工，同一个信封同一处判定；实测 ${JSON.stringify(threadChips.map(chip => chip.state))}）`);
  ok(open.rows === 8 && open.hiddenRows === 0 && open.shownRows.length === 8
    && open.headNodes === 5 && open.shownHeads === 5,
    `X1d 起手八行全可见，五个卡头（甲被隔开三次故有 4 个 ＋ 乙丙各 1 个… 实测 行=${open.rows} 卡头=${open.headNodes}/${open.shownHeads}）`);

  const filtered = await waitForEval(cdp, `(() => {
    const chip = document.querySelector('#stewardFeed .steward-channel[data-channel=${JSON.stringify(CH_A)}]');
    if (chip && !chip.classList.contains('is-on')) chip.click();
    const snapshot = ${CHANNELS};
    return snapshot.hiddenRows > 0 ? snapshot : null;
  })()`, 200);
  await shootX('F2-channels-only-alpha.png');
  ok(Boolean(filtered) && filtered.rows === open.rows && filtered.headNodes === open.headNodes,
    `X2 过滤是【呈现】不是数据：DOM 里的行数与卡头数一个没少（实测 行 ${open.rows}→${filtered && filtered.rows}，卡头 ${open.headNodes}→${filtered && filtered.headNodes}）`);
  ok(Boolean(filtered) && filtered.shownRows.length === 4
    && filtered.shownRows.every(id => id === CH_A) && filtered.hiddenRows === 4,
    `X2b 只看甲：甲那四行看得见，另外四行（乙／丙／用户／管家本人）藏起来（实测 可见 ${JSON.stringify(filtered && filtered.shownRows)}）`);
  ok(Boolean(filtered) && filtered.shownHeads === 1
    && filtered.seams.length === 4
    && filtered.seams.filter(seam => seam[1]).length === 1 && filtered.seams[0][1] === true
    && filtered.seams.filter(seam => seam[2]).length === 1 && filtered.seams[3][2] === true,
    `X3 被隔开三次的四行重新合成【一张】卡：一个卡头、一个段首、一个段尾（实测 卡头 ${filtered && filtered.shownHeads} / 段界 ${JSON.stringify(filtered && filtered.seams)}）`);
  ok(Boolean(filtered) && filtered.chips.filter(chip => chip.on).length === 1
    && filtered.chips[1].on === true && filtered.chips[1].pressed === 'true',
    `X3b 选中那一枚 chip 是实底态，且读屏念得到（aria-pressed；实测 ${JSON.stringify((filtered && filtered.chips || []).map(chip => [chip.name, chip.on, chip.pressed]))}）`);
  ok(Boolean(filtered)
    && filtered.target === zh['stewardShell.compose.targetThread'].replace('{{title}}', CH_A_TITLE),
    `X4 过滤开着时输入框的目标就是这条线程（走的是【既有的】手选态 picked，不是第二个「目标」；实测「${filtered && filtered.target}」）`);

  const cleared = await waitForEval(cdp, `(() => {
    const chip = document.querySelector('#stewardFeed .steward-channel[data-channel=${JSON.stringify(CH_A)}]');
    if (chip && chip.classList.contains('is-on')) chip.click();
    const snapshot = ${CHANNELS};
    return snapshot.hiddenRows === 0 ? snapshot : null;
  })()`, 200);
  ok(Boolean(cleared) && cleared.rows === open.rows && cleared.shownRows.length === 8
    && cleared.shownHeads === 5
    && cleared.chips.filter(chip => chip.on).length === 1 && cleared.chips[0].on === true,
    `X5 再点一次同一枚就取消：八行全回来、五个卡头全回来、实底那一枚回到「全部」（设计稿宽屏画板里它就是那枚深底 pill；实测 可见 ${cleared && cleared.shownRows.length} / 卡头 ${cleared && cleared.shownHeads} / 实底 ${JSON.stringify((cleared && cleared.chips || []).filter(chip => chip.on).map(chip => chip.name))}）`);
  ok(Boolean(cleared) && cleared.target === zh['stewardShell.compose.targetSteward'],
    `X5b 取消过滤，输入框的目标也回到进频道之前的样子（「${cleared && cleared.target}」）`);
  ok(Boolean(cleared) && JSON.stringify(cleared.seams) === JSON.stringify(open.seams),
    `X5c 取消之后每一段的段首段尾与过滤【之前】逐个相同 —— 重封用的就是 markThread 那一条判据，不是另一套（实测 ${JSON.stringify(cleared && cleared.seams)}）`);

  const selfOnly = await waitForEval(cdp, `(() => {
    const chip = document.querySelector('#stewardFeed .steward-channel[data-channel="steward:self"]');
    if (chip && !chip.classList.contains('is-on')) chip.click();
    const snapshot = ${CHANNELS};
    return snapshot.hiddenRows > 0 ? snapshot : null;
  })()`, 200);
  ok(Boolean(selfOnly) && selfOnly.rows === open.rows
    && JSON.stringify(selfOnly.shownRows) === JSON.stringify(['user', 'self'])
    && selfOnly.shownHeads === 0,
    `X6 「管家本人」这一档＝没有线程色条的那些行（用户的话与管家自己的话），一个卡头都不该出现（实测 ${JSON.stringify(selfOnly && selfOnly.shownRows)}）`);
  ok(Boolean(selfOnly) && selfOnly.target === zh['stewardShell.compose.targetSteward'],
    'X6b 「管家本人」不是一条线程，所以目标仍然是如意（不给一个不存在的 sessionId）');
  const allBack = await waitForEval(cdp, `(() => {
    const chip = document.querySelector('#stewardFeed .steward-channel[data-channel=""]');
    if (chip && !chip.classList.contains('is-on')) chip.click();
    const snapshot = ${CHANNELS};
    return snapshot.hiddenRows === 0 ? snapshot : null;
  })()`, 200);
  ok(Boolean(allBack) && allBack.shownRows.length === 8,
    `X7 点「全部」同样退得回来（实测 可见 ${allBack && allBack.shownRows.length} 行）`);
  // 本段【零新增请求】：一次到访 ＋ 一份历史 ＋ 六个回合各一发信封（甲 4 乙 1 丙 1）。
  // 上面四次点 chip 一发都没多 —— 过滤不重发任何东西。
  ok(Array.isArray(channelRun.calls) && channelRun.calls.length === 8,
    `X7b 频道条零新增请求：整段只有到访 1 ＋ 历史 1 ＋ 信封 6（实测 ${channelRun.calls.length} 发）`);
  const afterClicks = await cdp.evaluate('(window.__ruyiChannelCalls || []).length');
  ok(afterClicks === channelRun.calls.length,
    `X7c companion：四次点 chip 之后请求数一发没变（实测 ${channelRun.calls.length} → ${afterClicks}）`);
  const boardOpened = await waitForEval(cdp, `(() => {
    const entry = document.querySelector('#stewardFeed .steward-channels-board');
    if (entry) entry.click();
    const snapshot = ${CHANNELS};
    return snapshot.boardOpen ? snapshot : null;
  })()`, 200);
  ok(Boolean(boardOpened) && boardOpened.boardOpen === true,
    'X8 右端的「全部线程」把看板拉开（点的是 117h 那一个既有入口 #stewardStatusLine，不是第二条通道）');
  await cdp.evaluate(`(() => { const line = document.getElementById('stewardStatusLine'); if (line) line.click(); return true; })()`);

  // ─── Z F5b 撤回三态（32 号文 §2.2.2；设计稿「图标集」画板第二行「撤回：倒计时画成环」）──────
  // 手法与 T/U/F1/F2 四段一样：新建一个实例 ＋ 注入按 URL 分流的假 api，走 handOff 那条【真】路径
  // （递话 → 撤回按钮 → 窄窗 → 到期 → 撤回落定，四步一个都没绕）。
  // 为什么不在上面 F4/F5 那一段就地量：那里的窄窗只有 10 秒，而「逐秒采样 3 秒 ＋ 等它到期」要花掉
  // 十几秒，塞进去会把 F5「窄窗内可点」挤到窗外 —— 为一条新证据弄红三条老断言不是好买卖。
  // 放在最后还有一个好处：这一段起的那个 1000ms 计时器到点自清，⑥ 的 H2 基线因此一点不受影响。
  const UNDO_DICT = {};
  for (const key of ['undo', 'undoCountdown', 'switchTarget', 'undone', 'undoneFilesKept', 'handedOff', 'whoInstead', 'listSeparator', 'otherCandidates']) {
    UNDO_DICT['stewardShell.chat.' + key] = zh['stewardShell.chat.' + key];
  }
  const UNDO_SHOT = `(() => {
    const feed = document.getElementById('stewardFeed');
    const rows = [...feed.querySelectorAll('.steward-msg')].slice(window.__ruyiUndoFrom || 0);
    const holder = rows.map(row => row.querySelector('.steward-acts')).filter(Boolean).pop() || null;
    const btn = holder ? holder.querySelector('.steward-act') : null;
    const face = btn ? btn.querySelector('.steward-undo-face') : null;
    const receipt = rows.map(row => row.querySelector('.steward-receipt')).filter(Boolean).pop() || null;
    return {
      text: btn ? btn.textContent : null,
      // 宽度量到千分位（四舍五入到整像素会把「跳了半个字符」这种真事故抹平）。
      width: btn ? Math.round(btn.getBoundingClientRect().width * 1000) / 1000 : null,
      aria: btn ? btn.getAttribute('aria-label') : null,
      cls: btn ? btn.className : '',
      icons: btn ? btn.querySelectorAll('svg.ic').length : 0,
      face: Boolean(face),
      // 环自己占多大也要量：只比按钮宽度是不够的 —— 环是个定死 12px 的盒子，它一旦被删掉
      // （或缩成 0），按钮四次采样的宽度照样两两相等，本条却会当场看见 0。
      faceW: face ? Math.round(face.getBoundingClientRect().width * 1000) / 1000 : null,
      faceHidden: face ? face.getAttribute('aria-hidden') : '',
      ring: face ? getComputedStyle(face).getPropertyValue('--steward-undo-left').trim() : '',
      // 光看那个数会造出一条假绿断言：把 CSS 那条规则整条删掉，属性照样在、照样每秒变，环却
      // 一笔都没画。所以连【算完的画法】一起取——它是那个数真的走进了绘制的唯一证据。
      ringPaint: face ? getComputedStyle(face).backgroundImage : '',
      ringTitle: face ? (face.getAttribute('title') || '') : '',
      acts: rows.reduce((sum, row) => sum + row.querySelectorAll('.steward-act').length, 0),
      receipt: receipt ? receipt.textContent : '',
      receiptIcons: receipt ? receipt.querySelectorAll('svg.ic').length : 0,
    };
  })()`;
  const shotDirZ = path.join(os.tmpdir(), 'ruyi-F5b-shots');
  const shootZ = async name => {
    try {
      // 按钮行是【最后】追加进那一行的，appendSteward 里那次滚到底发生在它之前 —— 不补这一下，
      // 三张证据里的按钮都被输入框压掉半截（第一版就是这样，看不出环长什么样）。
      await cdp.evaluate(`(() => { const feed = document.getElementById('stewardFeed'); if (feed) feed.scrollTop = feed.scrollHeight; return true; })()`);
      fs.mkdirSync(shotDirZ, { recursive: true });
      const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shotDirZ, name), Buffer.from(png.data, 'base64'));
      console.log(`  截图：${path.join(shotDirZ, name)}`);
    } catch { /* 证据拍不下来不改变判定 */ }
  };
  const undoRun = await cdp.evaluate(`(async () => {
    const mod = await import('/js/steward-conversation.js');
    window.__ruyiUndoFrom = document.querySelectorAll('#stewardFeed .steward-msg').length;
    window.__ruyiUndoCalls = [];
    const dict = ${JSON.stringify(UNDO_DICT)};
    const conv = mod.createStewardConversation({
      api: async url => {
        const path_ = String(url);
        window.__ruyiUndoCalls.push(path_);
        if (path_ === '/api/steward/act') return { result: { ok: true, undoRef: { turnSeq: 0, rewindTargetTurnSeq: 1 } } };
        if (path_ === '/api/stop') return { ok: true };
        if (path_ === '/api/session/rewind') return { ok: true, filesReverted: ['docs/a.md'] };
        return { ok: true };
      },
      // 真中文目录（本段判定的是用户【看见】的那几个字），插值不走正则：模板串里写 \\{ 太容易被吃掉。
      t: (key, params) => {
        let out = String(dict[key] === undefined ? key : dict[key]);
        for (const name of Object.keys(params || {})) out = out.split('{{' + name + '}}').join(String(params[name]));
        return out;
      },
      isStewardMode: () => true,
    });
    const handed = await conv.handOff({
      sessionId: ${JSON.stringify(threadId)},
      title: ${JSON.stringify(THREAD_TITLE)},
      message: '把这条递过去',
      reason: '',
    });
    return { handed: Boolean(handed), calls: window.__ruyiUndoCalls.slice() };
  })()`);
  ok(Boolean(undoRun) && undoRun.handed === true && undoRun.calls.length === 1
    && undoRun.calls[0] === '/api/steward/act',
    `Z0 递话走的是 handOff 那条真路径，撤回按钮就位（实测 ${JSON.stringify(undoRun && undoRun.calls)}）`);
  // 逐秒采样：四次快照跨过 3.3 秒（窄窗 10 秒，采样只吃掉三分之一）。
  const ticks = [];
  for (let index = 0; index < 4; index += 1) {
    ticks.push(await cdp.evaluate(UNDO_SHOT));
    if (index === 1) await shootZ('F5b-1-counting-down.png');
    if (index < 3) await sleep(1100);
  }
  const texts = ticks.map(tick => tick.text);
  ok(texts.every(text => text === zh['stewardShell.chat.undo']),
    `Z1 倒计时里按钮的文字【逐字节不变】：四次采样跨 3.3 秒都是「${zh['stewardShell.chat.undo']}」（实测 ${JSON.stringify(texts)}）`);
  const widths = ticks.map(tick => tick.width);
  const faceWidths = ticks.map(tick => tick.faceW);
  ok(widths[0] > 0 && widths.every(width => width === widths[0])
    && faceWidths[0] > 0 && faceWidths.every(width => width === faceWidths[0]),
    `Z2 按钮宽度一动不动，且每秒在变的那个东西自己也占着一块【定死的】地方（改前位数从 10 掉到 9 时按钮跟着跳一下；实测 按钮 ${JSON.stringify(widths)} / 环 ${JSON.stringify(faceWidths)}）`);
  const rings = ticks.map(tick => tick.ring);
  const ringNums = rings.map(Number);
  ok(rings[0] === '1' && new Set(rings).size >= 3
    && ringNums.every((value, index) => index === 0 || value < ringNums[index - 1]),
    `Z3 环真的在退：驱动它的那个自定义属性从满格 1 一路单调变小、四次采样至少三个不同的值（实测 ${JSON.stringify(rings)}）`);
  const paints = ticks.map(tick => tick.ringPaint);
  ok(paints.every(paint => String(paint).indexOf('conic-gradient') >= 0) && new Set(paints).size >= 3,
    `Z3b 那个数不是写给测试看的：算完的 background-image 每秒跟着换（把 .steward-undo-face 整条规则删掉，本条立刻转红而 Z3 照样绿——那正是「删掉被测代码断言还过」的假绿）（实测 ${JSON.stringify(paints.map(paint => String(paint).slice(0, 96)))}）`);
  ok(ticks.every(tick => tick.aria === zh['stewardShell.chat.undo'])
    && ticks.every(tick => tick.face === true && tick.faceHidden === 'true'),
    `Z4 copy-P2-2 的无障碍契约原样：按钮 aria-label 恒是「撤回」，每秒在变的那个元素整棵子树 aria-hidden（实测 aria ${JSON.stringify([...new Set(ticks.map(tick => tick.aria))])} / hidden ${JSON.stringify([...new Set(ticks.map(tick => tick.faceHidden))])}）`);
  const titles = ticks.map(tick => tick.ringTitle);
  ok(new Set(titles).size >= 3 && titles.every(title => /\d/.test(title)),
    `Z4b 秒数没消失，只是从「文字」挪到了那枚 aria-hidden 元素的 title（鼠标停上去仍看得到；实测 ${JSON.stringify(titles)}）`);
  const expired = await waitForEval(cdp, `(() => {
    const snapshot = ${UNDO_SHOT};
    return snapshot.text === ${JSON.stringify(zh['stewardShell.chat.switchTarget'])} ? snapshot : null;
  })()`, 400);
  await shootZ('F5b-2-expired-switch.png');
  ok(Boolean(expired) && expired.aria === zh['stewardShell.chat.switchTarget']
    && expired.cls.indexOf('steward-act-switch') >= 0
    && expired.icons === 1 && expired.face === false,
    `Z5 到点变成「${zh['stewardShell.chat.switchTarget']}」，且换上了一枚图标 —— 图标这一下变化就是那次改口的过渡（改前是文字无声地换掉；实测 文字「${expired && expired.text}」/ 图标 ${expired && expired.icons} 枚 / 环还在=${expired && expired.face}）`);
  const clickedSwitch = await cdp.evaluate(`(() => {
    const feed = document.getElementById('stewardFeed');
    const rows = [...feed.querySelectorAll('.steward-msg')].slice(window.__ruyiUndoFrom || 0);
    const holder = rows.map(row => row.querySelector('.steward-acts')).filter(Boolean).pop();
    const btn = holder ? holder.querySelector('.steward-act') : null;
    if (btn) btn.click();
    return Boolean(btn);
  })()`);
  ok(clickedSwitch === true, 'Z6 「换一条」可点（它的行为仍是「先回退再递」——同一个 undoHandOff）');
  const undoSettled = await waitForEval(cdp, `(() => {
    const snapshot = ${UNDO_SHOT};
    return snapshot.receipt ? snapshot : null;
  })()`, 300);
  await shootZ('F5b-3-undone.png');
  ok(Boolean(undoSettled) && undoSettled.receipt === zh['stewardShell.chat.undone']
    && undoSettled.acts === 0 && undoSettled.receiptIcons === 1,
    `Z7 第三态：整行按钮退成一句安静的「✓ ${zh['stewardShell.chat.undone']}」——按钮一个不剩，对勾一枚（实测「${undoSettled && undoSettled.receipt}」/ 剩余按钮 ${undoSettled && undoSettled.acts} / 图标 ${undoSettled && undoSettled.receiptIcons}）`);
  const undoCalls = await cdp.evaluate('(window.__ruyiUndoCalls || []).slice()');
  ok(Array.isArray(undoCalls) && undoCalls.lastIndexOf('/api/stop') >= 0
    && undoCalls.lastIndexOf('/api/session/rewind') > undoCalls.lastIndexOf('/api/stop'),
    `Z7b companion：换一条走的仍是「先 stop 再 rewind」那条老路（实测 ${JSON.stringify(undoCalls)}）`);

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
