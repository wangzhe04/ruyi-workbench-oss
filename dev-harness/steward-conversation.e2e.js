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
const STEWARD_SAY = '我看了一眼，现在这条线程停在等你。';
// 剧本[0] = 测试②的管家回合（四个 acts —— 后端归一后前端只该渲染 ≤3 个）；delayMs 让「···」占位
// 有一段可观察的窗口。剧本[1+] = 递话之后那条线程自己的回合（内容不参与断言，钳到末条）。
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
  '好的，我接着做。',
];

function browserPath() {
  return [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].find(file => fs.existsSync(file)) || '';
}

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
  ok(Boolean(await waitForHttp(appPort, '/health', result => result.status === 200)), 'A1 workbench started');

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
      const nativeFetch = window.fetch;
      window.fetch = function (input, init) {
        try {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          window.__ruyiFetchLog.push(String(url).replace(/^https?:\\/\\/[^/]+/, '').split('?')[0]);
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

  // ─── ④ 输入含线程标题 → chip 变线程 → Enter 直接递 → 撤回 ─────────────────────
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    input.focus();
    input.value = ${JSON.stringify(THREAD_TITLE + ' 接着做，把华南的表补上')};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const chipThread = await waitForEval(cdp, `(() => {
    const snapshot = ${FEED};
    return snapshot.chip.indexOf(${JSON.stringify(THREAD_TITLE)}) >= 0 ? snapshot : null;
  })()`);
  ok(Boolean(chipThread), `F1 输入即预判：chip 变成「→ ${THREAD_TITLE}」`);

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
    'F2 Enter 直接递：管家只回一行「递给了『周报-W36』。」');
  ok(Boolean(handed) && handed.fetches.includes('/api/steward/act'),
    'F3 递话走 POST /api/steward/act（不经管家回合，后端零改动）');
  const undoLabel = handed ? handed.acts.find(label => label.startsWith(zh['stewardShell.chat.undo'])) : '';
  ok(Boolean(undoLabel) && /撤回 \d+/.test(undoLabel),
    `F4 回执按钮是带倒计时的「撤回 N」（实测 ${JSON.stringify(undoLabel)}）`);

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
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* browser profile lock */ }
  console.log(`\nSTEWARD CONVERSATION E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
