#!/usr/bin/env node
'use strict';

// 第117波 117d 真实浏览器 E2E（27 号文 §5 117d 行／§8.13「线程抽屉里的『话』」／§8.6「权限的界面表达」）。
// 造一个事项 ＋ 两条线程：A 的最后一条助手消息以问句收尾，B 挂着一条 question 待决。然后：
//   ① 开关开 → 进管家壳 → 派发 steward:open-thread(A) → 抽屉出现、十一个区块按契约顺序排布；
//   ② 事项行显示验收 a/b；线程页签两条（＋「＋ 线程」）；
//   ③ 「它刚说」＝最后一条助手消息【原话】的前 ≤3 句（不是摘要，也不是全文）；
//   ④ A 无待决且最后一句是问句 → 「你可以说」给「好，就这样」「先不要」；
//   ⑤ 权限 chip 切「改文件不问」→ GET /api/sessions/A 的 permissionMode === 'acceptEdits' 且 chip 回填；
//   ⑥ 权限 chip 切「全自动」→ 出二次确认 → 取消不变；再来一次 → 确认后变 'auto'；
//   ⑦ 点兄弟页签切到 B（同事项内换线程）；再开线程 C（自成事项、挂着 question 待决）→
//      「你可以说」来自待决的候选答案；点其中一条 → 该待决消失；
//      —— C 之所以不挂在事项 M 下：既有后端在「线程被 attach 进显式事项容器」后，
//      /api/chat/answer 这条兼容适配器传的 missionId 仍是 sessionId，而 decideIntervention 的
//      sessionMissionId(head) !== missionId 那道门会判 not_found（本波交付记录登记项，未修）。
//   ⑧ Esc 关闭抽屉；
//   ⑨ 切回经典壳后无残留定时器（抽屉轮询与 avatar 轮询都被清掉）。
// 与 steward-shell.e2e.js / steward-conversation.e2e.js 同一套 CDP 无头驱动；后端零改动。
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

const MISSION_TITLE = '季度收尾';
const THREAD_A = '报表汇总';
const THREAD_B = '整理素材';
const THREAD_C = '选个框架';
const THREAD_D = '再选一次框架';
// 117l D4：挂起前先流出去的那段正文（四句）。抽屉的「它正在说」只该显示【末尾】三句。
const LIVE_PIECES = ['我先看了三个候选。', '一是 React。', '二是 Vue。', '三是原生。'];
const LIVE_TAIL3 = '一是 React。二是 Vue。三是原生。';
// A 的最后一条助手消息：四句，末句是问句。抽屉只该显示前三句（§8.13「≤3 句」）。
const A_REPLY = '我先看了一眼报表。三个区的数字都对上了。差的是华南那张表。要不要我把汇总也做了？';
const A_FIRST3 = '我先看了一眼报表。三个区的数字都对上了。差的是华南那张表。';
const POLL_MS = 120000;   // 配置的节拍拉满：测试窗口内不会真的去拉，计时器只按周期数个数
// 117j W2-5：表按 5s 下限起（见 steward-drawer.js pollSlice 头注），所以数计时器要按这个周期。
// 表虽然每 5 秒响一次，但 pollSlice 第一件事就是「离上次拉够 120000ms 了吗」——不够就原地返回，
// 测试窗口内一个请求都不会多发，断言仍然是确定的。
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

// 117l D2：审计流水（与 steward-relay-channels.e2e.js 同一读法）。「有没有 supersede 掉一个
// 等回答的回合」只有 turn_kill 这一行说了算 —— 界面上看不出来（截图 2 里「0 条等你」正是因为
// 问题已经被杀没了）。logsDir 在真正建出 home 之后才知道，所以这里接受一个目录参数。
function auditRowsIn(dir) {
  const out = [];
  for (const file of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
    if (!file.endsWith('.ndjson')) continue;
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return out;
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* already exited */ }
}

// 确定性 provider：按用户原话分流。'ask' → 一条 request_user_input（挂成 question 待决）；
// 其余 → 一段以问句收尾的助手文本。答完之后再问一次就收尾，避免回合永远挂着。
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
    const wantsQuestion = /ask/i.test(String((lastUser && lastUser.content) || ''));
    // 117l：自由回答（问答卡的 textarea）送进去的不是 React/Vue 而是用户自己写的一句话，所以
    // 「答过了吗」的判据从「工具结果里有 React|Vue」放宽成「有过任何一条工具结果」。
    const answered = messages.some(message => message && message.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const sse = value => res.write('data: ' + JSON.stringify(value) + '\n\n');
    if (wantsQuestion && !answered) {
      const args = JSON.stringify({ questions: [{
        id: 'framework', header: 'Framework', question: '接着用哪个框架？', answerMode: 'single',
        options: [{ id: 'react', label: 'React' }, { id: 'vue', label: 'Vue' }],
      }] });
      // 117l D4：先流一段正文再挂起 —— 回合活着时服务端的 liveTail 里才有东西，
      // 抽屉的「它正在说」才有可验的内容（四句，抽屉只该显示【末尾】三句）。
      for (const piece of LIVE_PIECES) sse({ choices: [{ index: 0, delta: { role: 'assistant', content: piece }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_117d_question', type: 'function', function: { name: 'request_user_input', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else if (answered) {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '知道了，就按这个来。' }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    } else {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: A_REPLY }, finish_reason: null }] });
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
  if (!document.getElementById('stewardDrawer') || !window.state || !window.state.status || !window.state.config) return null;
  return { ready: true };
})()`;

// 抽屉快照：全部走 textContent / 属性，不碰任何模块私有状态。
const DRAWER = `(() => {
  const drawer = document.getElementById('stewardDrawer');
  // 117l D4 重钉：区块清单从 11 变 13（多了「它在问你」与「更多」容器；四块折进后者，顺序不变）。
  const ids = ['stewardDrawerMission','stewardDrawerTabs','stewardDrawerHead','stewardDrawerAsk',
    'stewardDrawerChips','stewardDrawerLastSay','stewardDrawerQuickReplies','stewardDrawerMore',
    'stewardDrawerRelay','stewardDrawerActivity','stewardDrawerAcceptance','stewardDrawerScene',
    'stewardDrawerFoot'];
  const nodes = ids.map(id => document.getElementById(id));
  const ordered = nodes.every((node, index) => node && (index === 0
    || (nodes[index - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0));
  const text = id => { const node = document.getElementById(id); return node ? node.textContent.trim() : ''; };
  return {
    hidden: drawer ? drawer.hidden : null,
    role: drawer ? drawer.getAttribute('role') : '',
    labelledby: drawer ? drawer.getAttribute('aria-labelledby') : '',
    ariaModal: drawer ? drawer.getAttribute('aria-modal') : null,
    shellDrawer: document.getElementById('stewardShell') ? (document.getElementById('stewardShell').dataset.drawer || '') : '',
    ordered,
    missionTitle: text('stewardDrawerMissionTitle'),
    missionAcceptance: text('stewardDrawerMissionAcceptance'),
    tabs: [...document.querySelectorAll('#stewardDrawerTabs .steward-drawer-tab')].map(node => node.textContent.trim()),
    tabSelected: [...document.querySelectorAll('#stewardDrawerTabs [role="tab"]')].map(node => node.getAttribute('aria-selected')),
    tabRoles: [...document.querySelectorAll('#stewardDrawerTabs [role="tab"]')].length,
    tablist: document.getElementById('stewardDrawerTabs') ? document.getElementById('stewardDrawerTabs').getAttribute('role') : '',
    title: text('stewardDrawerTitle'),
    state: text('stewardDrawerState'),
    lastSay: text('stewardDrawerLastSayText'),
    lastSayHead: text('stewardDrawerLastSayHead'),
    // 117l D4：④「它在问你」卡片、⑦ 是否被它顶掉、⑧「更多」的收起状态、焦点在哪。
    askHidden: document.getElementById('stewardDrawerAsk') ? document.getElementById('stewardDrawerAsk').hidden : null,
    askLines: [...document.querySelectorAll('#stewardDrawerAskText .steward-drawer-ask-line')].map(node => node.textContent.trim()),
    askOptions: [...document.querySelectorAll('#stewardDrawerAskOptions .steward-drawer-reply')].map(node => node.textContent.trim()),
    askOptionKinds: [...document.querySelectorAll('#stewardDrawerAskOptions .steward-drawer-reply')].map(node => node.dataset.replyKind),
    askFocused: document.activeElement === document.getElementById('stewardDrawerAskInput'),
    quickRepliesHidden: document.getElementById('stewardDrawerQuickReplies')
      ? document.getElementById('stewardDrawerQuickReplies').hidden : null,
    moreOpen: document.getElementById('stewardDrawerMore') ? document.getElementById('stewardDrawerMore').open : null,
    replies: [...document.querySelectorAll('#stewardDrawerQuickRepliesRow .steward-drawer-reply')].map(node => node.textContent.trim()),
    replyKinds: [...document.querySelectorAll('#stewardDrawerQuickRepliesRow .steward-drawer-reply')].map(node => node.dataset.replyKind),
    relayHidden: document.getElementById('stewardDrawerRelay') ? document.getElementById('stewardDrawerRelay').hidden : null,
    relay: [...document.querySelectorAll('#stewardDrawerRelayList li')].map(node => node.textContent.trim()),
    acceptance: [...document.querySelectorAll('#stewardDrawerAcceptanceList li')].map(node => node.textContent.trim()),
    activityDoing: text('stewardDrawerActivityDoing'),
    activityWaiting: text('stewardDrawerActivityWaiting'),
    chipKeys: [...document.querySelectorAll('#stewardDrawerChips .steward-chip')].map(node => node.dataset.chip),
    chipValues: [...document.querySelectorAll('#stewardDrawerChips .steward-chip .steward-chip-value')].map(node => node.textContent.trim()),
    // 117u-G3（§11.15.7）：这一行【这一拍印不印】。量的是真绘制（offsetParent === null 才叫没画出来），
    // 不是只读 .hidden 属性 —— .steward-drawer-chips 那条 display:flex 是作者样式，会盖掉 UA 的
    // [hidden]{display:none}，只读属性的话「属性挂上了但照样占着一行」这种回归照样绿。
    // 117u-G3b：两面对判据的答案【有意做不同的事】，所以这里要分别量「控件在不在」与「值印不印」。
    chipsHidden: (() => {
      const host = document.getElementById('stewardDrawerChips');
      if (!host) return null;
      const values = [...host.querySelectorAll('.steward-chip-value')];
      const keys = [...host.querySelectorAll('.steward-chip-key')];
      return {
        attr: host.hidden,
        painted: host.offsetParent !== null,               // 控件行整体有没有画出来
        isDefault: host.classList.contains('is-default'),
        valuesPainted: values.filter(node => node.offsetParent !== null).length,   // 值那半画出来几个
        keysPainted: keys.filter(node => node.offsetParent !== null).length,       // 键那半（入口）还在几个
      };
    })(),
    confirmVisible: document.querySelectorAll('#stewardDrawerChips .steward-chip-confirm').length,
    confirmLines: [...document.querySelectorAll('#stewardDrawerChips .steward-chip-confirm li')].map(node => node.textContent.trim()),
    note: text('stewardDrawerNote'),
    // F5a（27 号文 §11.13.1「F 追加」）：状态药丸里那枚由五态派生的字形，以及底部动作键的
    // 「图标＋文字」形状。后者钉的是一件很容易悄悄坏掉的事 —— i18n 的 applyTranslations 写的是
    // textContent，一旦 data-i18n 挂回 button 本体，hydrateIcons 注入的 SVG 会在下一次 setLocale
    // 时被整个抹掉（boot 里就有那第二次）。icons 计数掉到 0 就是这条回归。
    stateGlyphs: (() => {
      const node = document.getElementById('stewardDrawerState');
      return node ? [...node.querySelectorAll('svg path')].map(item => item.getAttribute('d')) : [];
    })(),
    footActions: [...document.querySelectorAll('#stewardDrawerFoot .steward-drawer-btn')].map(node => ({
      id: node.id,
      icons: node.querySelectorAll('svg.ic').length,
      rects: node.querySelectorAll('svg rect').length,
      text: node.textContent.trim(),
    })),
    intervals: window.__ruyiLiveIntervals ? window.__ruyiLiveIntervals() : [],
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-drawer-'));
const home = path.join(root, 'home');
const profile = path.join(root, 'profile');
const auditRows = () => auditRowsIn(path.join(home, 'logs'));
fs.mkdirSync(home);
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
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200, undefined, 300)), 'A1 workbench started'); // 117q:此启动门原吃默认 attempts=200(200×80ms=16s)低于 30 号文 P1-31 建议的 300×同款间隔量级,是「FAIL workbench up」假红的根;默认值被本文件下方大量业务断言调用复用,不能整体抬,这里改成显式传 300 只抬这一处(30 号文 P1-31)

  let token = '';
  for (let i = 0; i < 80 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A2 runtime token 可读');

  // ── 造事项与两条线程 ────────────────────────────────────────────────────────
  const createdA = await request(appPort, 'POST', '/api/sessions', { title: THREAD_A, cwd: home }, token);
  const createdB = await request(appPort, 'POST', '/api/sessions', { title: THREAD_B, cwd: home }, token);
  const createdC = await request(appPort, 'POST', '/api/sessions', { title: THREAD_C, cwd: home }, token);
  // 117l D4：D 与 C 同形（都挂在 request_user_input 上），区别只在【怎么答】—— C 点选项，
  // D 用问答卡的自由回答框。两条各自要一个待决，所以必须是两条线程。
  const createdD = await request(appPort, 'POST', '/api/sessions', { title: THREAD_D, cwd: home }, token);
  const idA = createdA && createdA.json && createdA.json.session && createdA.json.session.id;
  const idB = createdB && createdB.json && createdB.json.session && createdB.json.session.id;
  const idC = createdC && createdC.json && createdC.json.session && createdC.json.session.id;
  const idD = createdD && createdD.json && createdD.json.session && createdD.json.session.id;
  ok(Boolean(idA && idB && idC && idD), `A3 四条线程已建（${idA || '失败'} / ${idB || '失败'} / ${idC || '失败'} / ${idD || '失败'}）`);
  if (!idA || !idB || !idC || !idD) throw new Error('session fixtures unavailable');

  // 会话头的 mission 账本：kind 翻 'mission'（否则不进 /api/missions 的投影），并给两条里程碑 ——
  // 抽屉 ⑨ 验收项读的是这一份（GET /api/missions/:id 的 snapshot.acceptance.items）。
  // D 也要 kind='mission'：否则它不进 /api/missions 的投影，而 117h 的「现在这一件」会按行数据
  // 自己挑焦点线程并把抽屉拽走（实测：D 不在行里时，focus-thread 打开 D 之后当拍就被换回别的线程）。
  for (const [id, goal] of [[idA, '把季度报表汇总出来'], [idB, '把素材归档'], [idC, '定下前端框架'], [idD, '再定一次前端框架']]) {
    await request(appPort, 'POST', '/api/mission', {
      sessionId: id, action: 'start', goal,
      milestones: [{ id: 'm1', desc: '拿到三个区的数字' }, { id: 'm2', desc: '汇总表可打开' }],
    }, token);
  }
  // 事项容器：抽屉 ① 事项行的验收 a/b 读的是【容器】的 acceptance（与线程里程碑是两层账）。
  const container = await request(appPort, 'POST', '/api/missions', {
    title: MISSION_TITLE,
    acceptance: [{ text: '汇总表交付', done: true }, { text: '框架定下来', done: false }],
  }, token);
  const missionId = container && container.json && container.json.mission && container.json.mission.missionId;
  ok(Boolean(missionId), `A4 事项容器已建（${missionId || '失败'}）`);
  for (const id of [idA, idB]) {
    await request(appPort, 'POST', `/api/missions/${encodeURIComponent(missionId)}/threads`, { action: 'attach', sessionId: id }, token);
  }
  const attached = await request(appPort, 'GET', '/api/missions?limit=200', null, token);
  const attachedRows = (attached && attached.json && attached.json.missions) || [];
  ok(attachedRows.filter(row => String(row.missionId) === String(missionId)).length === 2,
    'A5 两条线程都挂在同一个事项下（页签的兄弟线程来源）');

  // A 跑一个回合 → 最后一条助手消息以问句收尾。
  await request(appPort, 'POST', '/api/chat/stream', { sessionId: idA, message: '把报表汇总一下', cwd: home }, token);
  const withReply = await waitForHttp(appPort, 'GET', `/api/sessions/${idA}`, result => {
    const messages = (result.json && result.json.session && result.json.session.messages) || [];
    return messages.some(message => message && message.role === 'assistant' && String(message.content || '').includes('华南'));
  }, token);
  ok(Boolean(withReply), 'A6 线程 A 有了一条以问句收尾的助手消息');

  // C 跑一个回合并停在 question 待决（不 await：这条回合要一直挂着等答案）。
  // C 【不】挂进事项 M —— 见文件头注：既有后端在 attach 之后送不进决策。
  // 【只起 C】。D 的回合留到 C 被答完之后再起 —— 两条挂在 request_user_input 上的回合共用同一个
  // 工作区，第二条会一直卡在资源租约上（实测：provider 只收到一次带 messages 的请求，第二条线程
  // 的回合根本没起来）。这是夹具的约束，不是被测行为。
  request(appPort, 'POST', '/api/chat/stream', { sessionId: idC, message: 'ask which framework', cwd: home }, token);
  const pendingReady = await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return pending.some(item => item && item.type === 'question' && item.sessionId === idC);
  }, token);
  ok(Boolean(pendingReady), 'A7 线程 C 挂着一条 question 待决');

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
  // addScriptToEvaluateOnNewDocument 只作用于【新文档】：连上 CDP 时页面已经加载完了，必须刷一次
  // 才装得上计时器探针。
  await cdp.evaluate('location.reload(); true');
  await waitForEval(cdp, READY);
  ok(Boolean(await waitForEval(cdp, 'Array.isArray(window.__ruyiLiveIntervals && window.__ruyiLiveIntervals()) ? 1 : null')),
    'A10 计时器探针已装上');

  // ── ① 进管家壳 → 派发 steward:open-thread(A) ────────────────────────────────
  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgShellMode');
    select.value = 'steward';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === 'steward'`);
  await cdp.evaluate(`document.dispatchEvent(new CustomEvent('steward:open-thread', { detail: { sessionId: '${idA}' } })), true`);
  const openedA = await waitForEval(cdp, `(() => {
    const snapshot = ${DRAWER};
    return snapshot.hidden === false && snapshot.tabs.length >= 3 && snapshot.lastSay ? snapshot : null;
  })()`);
  ok(Boolean(openedA), 'B1 抽屉打开并把线程 A 的内容填满');
  if (!openedA) throw new Error('drawer did not open');
  ok(openedA.role === 'dialog' && openedA.labelledby === 'stewardDrawerTitle',
    'B2 抽屉是 role="dialog" + aria-labelledby="stewardDrawerTitle"');
  // 117l D4 重钉：11 → 13（多了「它在问你」与「更多」；四块折进后者，一块没少、顺序没变）。
  ok(openedA.ordered === true, 'B3 十三个区块的 DOM 顺序 === §11.9 D4 的契约顺序');
  ok(openedA.shellDrawer === 'open', 'B4 宽屏下管家壳被标为 drawer=open（对话区收窄，抽屉占右侧 390px 栏）');
  ok(openedA.ariaModal === null, 'B4b 1440px 宽屏是栏式，不加 aria-modal');
  ok(openedA.tablist === 'tablist' && openedA.tabRoles === 2,
    `B5 线程页签是 tablist，两条兄弟线程各一个 tab（实测 ${openedA.tabRoles}）`);
  ok(openedA.tabs.length === 3 && openedA.tabs[2] === zh['stewardShell.drawer.newThread'],
    `B5b 页签行末尾是「＋ 线程」（实测 ${JSON.stringify(openedA.tabs)}）`);
  // 117k 重钉（用户第三轮走查④）：事项【容器】的标题现在【就在】行里 —— 116-5b 给 GET /api/missions
  // 的每一行加了 missionTitle（显式容器＝用户起的名，派生事项＝那条线程的显示名）。本条此前钉的是
  // 「回落到本线程标题」，那是 116-5b 之前的世界；照那条回落，同一块面板上事项行写整句原话、
  // 下面的页签写生成名 —— 一块面板三个名字指同一件事（用户走查原话：看不出这是同一件）。
  ok(openedA.missionTitle === MISSION_TITLE,
    `B6 事项行显示【事项容器】的名字（用户起的那个，实测「${openedA.missionTitle}」）`);
  // companion：同一帧里线程自己的名字不许被事项名顶掉 —— 两个名字各就各位才是这条修法的完整形状。
  ok(openedA.title === THREAD_A,
    `B6b 同一帧里线程头仍是线程自己的名字（实测「${openedA.title}」）`);
  ok(openedA.missionAcceptance === zh['stewardShell.drawer.acceptanceCount'].replace('{{done}}', '1').replace('{{total}}', '2'),
    `B7 事项行显示验收 a/b（实测「${openedA.missionAcceptance}」）`);
  ok(openedA.title === THREAD_A, `B8 线程头显示线程标题（实测「${openedA.title}」）`);
  // ── F5a（§11.13.1「F 追加」）：动作配图标、五态药丸配图标 ─────────────────────────────
  const stopAction = openedA.footActions.find(action => action.id === 'stewardDrawerStopBtn');
  ok(openedA.footActions.length >= 5
    && openedA.footActions.every(action => action.icons === 1 && action.text.length > 0)
    && stopAction && stopAction.rects === 1,
    `B8c F5a：底部每一枚动作都是【图标 ＋ 文字】（不是纯图标，也不是被 i18n 抹掉了图标的纯文字）；线程「停止」那一枚是实心方块（<rect>），与头部管家停机的电源符不同形（实测 ${JSON.stringify(openedA.footActions.map(action => action.id + ':' + action.icons + '/' + action.text))}）`);
  // 五态人话【不在这里再列一遍】：从目录里按 mission.state.* 前缀取（30 号文 §4.4 那一组键）。
  const stateLabels = Object.keys(zh).filter(key => key.startsWith('mission.state.')).map(key => zh[key]);
  ok(openedA.stateGlyphs.length > 0 && stateLabels.includes(openedA.state),
    `B8d F5a：状态药丸带一枚由五态派生的字形，文字仍逐字是那句五态人话（实测「${openedA.state}」＋${openedA.stateGlyphs.length} 条路径）`);
  // 五态取 mission-state.js 的 fromCard（全仓唯一判据）。卡片投影不带 turnSeq，跑过 chat 回合但没有
  // agent run、没有里程碑完成的 mission 会话按那份判据就是「交办中」—— 抽屉如实照搬，不另编一套。
  // 117q-B3b 重钉：五态人话键从 stewardShell.drawer.state.* 搬到中性的 mission.state.*（30 号文 §4.4）。
  const STATE_LABELS = ['dispatching', 'running', 'needs_you', 'done', 'stopped', 'quick_ask']
    .map(value => zh[`mission.state.${value}`]);
  ok(STATE_LABELS.includes(openedA.state),
    `B9 线程头显示五态人话，且落在 mission-state.js 的枚举里（实测「${openedA.state}」）`);
  ok(openedA.lastSay === A_FIRST3,
    `B10 「它刚说」＝最后一条助手消息原话的前 3 句（实测「${openedA.lastSay}」）`);
  ok(!openedA.lastSay.includes('要不要我把汇总也做了'), 'B10b 第四句被截掉（≤3 句，不是全文）');
  ok(openedA.replies.length === 2
    && openedA.replies[0] === zh['stewardShell.drawer.reply.yes']
    && openedA.replies[1] === zh['stewardShell.drawer.reply.no'],
    `B11 A 无待决、末句是问句 → 「你可以说」给「好，就这样」「先不要」（实测 ${JSON.stringify(openedA.replies)}）`);
  // ── 117l D4（用户第四轮走查①③）：软问句也算「它在问你」；四块折进「更多」并默认收起 ──────
  ok(openedA.askHidden === false && openedA.askLines.length === 1
    && openedA.askLines[0].indexOf('要不要我把汇总也做了') >= 0,
    `B16 A 的最后一句是问句 → ④「它在问你」把【问题原文】摆出来（实测 ${JSON.stringify(openedA.askLines)}）`);
  ok(openedA.askOptions.length === 0 && openedA.quickRepliesHidden === false,
    'B16b 软问句没有选项按钮 → ⑦「你可以说」照常在（只有 ④ 真给出选项时 ⑦ 才让位）');
  ok(openedA.lastSay === A_FIRST3,
    `B16c ④ 里是【末句问话】、⑥ 里仍是原话开头三句，两处不重复（实测「${openedA.lastSay}」）`);
  ok(openedA.moreOpen === false,
    `B17 ⑧「更多」默认收起（走查③「线程页内容还是太多太杂」；实测 open=${openedA.moreOpen}）`);
  const focusedA = await waitForEval(cdp, `(() => (${DRAWER}).askFocused ? { ok: 1 } : null)()`);
  ok(Boolean(focusedA), 'B18 打开线程、数据到齐之后焦点落进问答框（走查①「打开线程回答」按下去该发生的事）');
  ok(openedA.lastSayHead === zh['stewardShell.drawer.lastSay'],
    `B19 A 没有在跑 → 标题是「它刚说」（实测「${openedA.lastSayHead}」）`);
  ok(openedA.relayHidden === false && openedA.relay.length === 1 && openedA.relay[0].includes(THREAD_B),
    `B12 接力关系列出同事项的另一条线程（实测 ${JSON.stringify(openedA.relay)}）`);
  ok(openedA.acceptance.length === 2 && openedA.acceptance[0].includes('三个区'),
    `B13 验收项来自任务快照（实测 ${JSON.stringify(openedA.acceptance)}）`);
  ok(JSON.stringify(openedA.chipKeys) === JSON.stringify(['permission', 'model', 'engine']),
    `B14 快切 chip 三个：权限／模型／引擎（实测 ${JSON.stringify(openedA.chipKeys)}）`);
  // 117u-G3 **重钉 B14b**（§11.15.7；用户 2026-09-09「这个也不印默认值吧」）：原判据钉的是
  // 「权限 chip 初始印着『跟随全局』」—— 那正是这一刀要消灭的病（§11.15.2 病 3：默认值印了等于没印）。
  // 新判据把同一件事实翻到该在的那一面：跟随全局的这一拍，这一行【不画出来】；而控件本身没被拆
  // （三枚 chip 仍在 DOM 里、值仍然读得出「跟随全局」——收的是墨量，不是能力）。
  // 另一侧在下面 C3b 钉：真定过会话级档位之后它必须现身。只钉一侧的话，把判据写成恒假也能绿。
  //
  // 117u-G3b 再重钉（主会话裁决，§11.15.8）：G3 第一版把【整行】藏起来，与看板同法。裁决改成
  // 「本面只收值、不收控件」—— 详情栏这一行是「给这条线程单独定一档」在管家壳里的入口，藏掉整行
  // 等于把入口收走，而用户要的只是「不印默认值」。所以判据翻成三件同时成立的事：
  //   ① 这一拍被判成「跟全局一样」（is-default 挂上了）；② 值那半【一个都没画出来】；
  //   ③ 键那半（＝入口）三个一个不少地【还画着】—— 这一条是新加的，正是它守住「没把能力删掉」。
  const chA = openedA.chipsHidden;
  ok(chA && chA.isDefault === true && chA.painted === true && chA.valuesPainted === 0 && chA.keysPainted === 3
    && openedA.chipValues[0] === zh['stewardShell.chips.followGlobal'],
    `B14b 跟随全局时详情栏【不印默认值但留着控件】（实测 is-default=${chA && chA.isDefault} 行画出来=${chA && chA.painted} 值画出来=${chA && chA.valuesPainted} 键画出来=${chA && chA.keysPainted}），值仍读得出「${openedA.chipValues[0]}」`);
  // 117j W2-5：三个管家计时器统一按 5s 下限起表（真要不要拉由每一拍自己判），
  // 所以「这是管家的计时器」的身份判据从 POLL_MS 重钉到 TICK_MS —— 不改的话本断言恒真、形同虚设。
  ok(openedA.intervals.filter(ms => ms === TICK_MS).length === 2,
    `B15 抽屉自己的轮询与 avatar 轮询各一（实测 ${JSON.stringify(openedA.intervals)}）`);

  // ── ⑤ 权限 chip 切「改文件不问」 ────────────────────────────────────────────
  await cdp.evaluate(`document.querySelector('#stewardDrawerChips [data-chip="permission"]').click(), true`);
  ok(Boolean(await waitForEval(cdp, `!!document.querySelector('#stewardDrawerChips [data-permission-mode="acceptEdits"]')`)),
    'C1 权限 chip 点开四档菜单');
  const menuText = await cdp.evaluate(`(() => [...document.querySelectorAll('#stewardDrawerChips [data-permission-mode]')]
    .map(node => node.textContent.trim()))()`);
  ok(menuText.length === 5 && menuText.slice(0, 4).every(text => text.length > 12)
    && menuText[4] === zh['stewardShell.chips.followGlobal'],
    `C1b 四档各带一句人话，末行是「跟随全局」（实测 ${JSON.stringify(menuText)}）`);
  await cdp.evaluate(`document.querySelector('#stewardDrawerChips [data-permission-mode="acceptEdits"]').click(), true`);
  const acceptEdits = await waitForHttp(appPort, 'GET', `/api/sessions/${idA}`,
    result => result.json && result.json.session && result.json.session.permissionMode === 'acceptEdits', token);
  ok(Boolean(acceptEdits), 'C2 切「改文件不问」后 GET /api/sessions/A 的 permissionMode === "acceptEdits"');
  const refilled = await waitForEval(cdp, `(() => {
    const snapshot = ${DRAWER};
    return snapshot.chipValues[0] === ${JSON.stringify(zh['stewardShell.permission.acceptEdits.label'])} ? snapshot : null;
  })()`);
  ok(Boolean(refilled), 'C3 chip 用响应回填成「改文件不问」');
  // 117u-G3 新钉（B14b 的另一侧）：真定过会话级档位之后，这一行必须【现身】—— 判据的权限那一半
  // 读的正是 chips 自己 render() 画上去的 .is-pinned。两侧都钉住，「恒不印」与「恒印」都会被打红。
  // 117u-G3b 随 B14b 一并翻面：现身的标志从「整行 hidden=false」改成「值那半真画出来了」。
  const chB = refilled && refilled.chipsHidden;
  ok(chB && chB.isDefault === false && chB.painted === true && chB.valuesPainted === 3,
    `C3b 定过会话级权限档之后这一行的【值】印出来（实测 is-default=${chB && chB.isDefault} 行画出来=${chB && chB.painted} 值画出来=${chB && chB.valuesPainted}）`);

  // ── ⑥ 切「全自动」：二次确认 → 取消不变 → 再来一次确认才变 ──────────────────
  await cdp.evaluate(`document.querySelector('#stewardDrawerChips [data-chip="permission"]').click(), true`);
  await cdp.evaluate(`document.querySelector('#stewardDrawerChips [data-permission-mode="auto"]').click(), true`);
  const confirming = await waitForEval(cdp, `(() => {
    const snapshot = ${DRAWER};
    return snapshot.confirmVisible === 1 ? snapshot : null;
  })()`);
  ok(Boolean(confirming), 'D1 切「全自动」先出二次确认，不直接 PATCH');
  ok(confirming && confirming.confirmLines.length === 5, `D1b 确认里逐条写明 §8.6 那五件事（实测 ${confirming && confirming.confirmLines.length} 条）`);
  ok(confirming && confirming.confirmLines.join('') .includes('永久豁免'), 'D1c 其中一条写明「永久豁免仍不做」');
  await cdp.evaluate(`document.querySelector('#stewardDrawerChips [data-confirm="cancel"]').click(), true`);
  await sleep(300);
  const afterCancel = await request(appPort, 'GET', `/api/sessions/${idA}`, null, token);
  ok(afterCancel && afterCancel.json.session.permissionMode === 'acceptEdits',
    'D2 取消后权限档不变（还是「改文件不问」）');
  await cdp.evaluate(`document.querySelector('#stewardDrawerChips [data-chip="permission"]').click(), true`);
  await cdp.evaluate(`document.querySelector('#stewardDrawerChips [data-permission-mode="auto"]').click(), true`);
  await waitForEval(cdp, `!!document.querySelector('#stewardDrawerChips [data-confirm="ok"]')`);
  await cdp.evaluate(`document.querySelector('#stewardDrawerChips [data-confirm="ok"]').click(), true`);
  const auto = await waitForHttp(appPort, 'GET', `/api/sessions/${idA}`,
    result => result.json && result.json.session && result.json.session.permissionMode === 'auto', token);
  ok(Boolean(auto), 'D3 确认后 permissionMode 变 "auto"（服务端要 confirm:true 才肯切）');
  ok(Boolean(await waitForEval(cdp, `(() => {
    const snapshot = ${DRAWER};
    return snapshot.chipValues[0] === ${JSON.stringify(zh['stewardShell.permission.auto.label'])} ? snapshot : null;
  })()`)), 'D3b chip 回填成「全自动」');

  // ─── ⑦-1 点兄弟页签换线程（同事项内切换） ────────────────────────
  await cdp.evaluate(`document.querySelector('#stewardDrawerTabs [data-session-id="${idB}"]').click(), true`);
  const onB = await waitForEval(cdp, `(() => {
    const snapshot = ${DRAWER};
    return snapshot.title === ${JSON.stringify(THREAD_B)} ? snapshot : null;
  })()`);
  ok(Boolean(onB), 'E1 点兄弟页签切到线程 B（抽屉换线程，不重开）');
  ok(onB && onB.tabSelected.filter(value => value === 'true').length === 1,
    'E1b 同一时刻只有一个页签是 aria-selected="true"');
  ok(onB && onB.lastSay === zh['stewardShell.drawer.lastSayEmpty'],
    `E1c B 没说过话 → 「它刚说」如实留空（实测「${onB && onB.lastSay}」）`);

  // ─── ⑦-2 开线程 C（自成事项、挂着 question 待决） ────────────────
  await cdp.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: '${idC}' } })), true`);
  const onC = await waitForEval(cdp, `(() => {
    const snapshot = ${DRAWER};
    return snapshot.title === ${JSON.stringify(THREAD_C)} && snapshot.replies.length ? snapshot : null;
  })()`);
  ok(Boolean(onC), 'E2 steward:focus-thread 也能打开抽屉（117h「现在这一件」接同一个口）');
  // 117l D4 重钉 E3/E3b（用户第四轮走查①）：候选答案【搬进了④「它在问你」卡】。旧断言钉的是
  // 「它们在 ⑥『你可以说』那一行里」—— 那是 117d 的位置，而用户的原话是「弹出打开线程回答，
  // 却并没有 2.0 的那种问答框，导致没法正常地回复」：光有一排 chip、没有问题原文也没有输入框。
  // 现在问题原文＋选项＋回答框在同一张卡里，⑥ 让位（否则一屏两排一模一样的按钮）。
  // companion（E3c）：⑥ 是【隐藏】不是【被删】—— 没有选项的软问句仍然由它出「好，就这样／先不要」。
  ok(onC && JSON.stringify(onC.askOptions) === JSON.stringify(['React', 'Vue']),
    `E3 候选答案在 ④「它在问你」卡里（实测 ${onC && JSON.stringify(onC.askOptions)}）`);
  ok(onC && onC.askOptionKinds.every(kind => kind === 'question'), 'E3b 这两条的 kind 是 question（走 /api/chat/answer）');
  ok(onC && onC.quickRepliesHidden === true,
    'E3c companion：④ 出选项时 ⑥「你可以说」整块隐藏（不是被删 —— B16b 里软问句那一档它照常在）');
  ok(onC && onC.askHidden === false && onC.askLines.length === 1 && onC.askLines[0] === '接着用哪个框架？',
    `E3f ④ 里是【问题原文】而不是一句摘要（实测 ${onC && JSON.stringify(onC.askLines)}）`);
  ok(Boolean(await waitForEval(cdp, `(() => (${DRAWER}).askFocused ? { ok: 1 } : null)()`)),
    'E3g 切到 C 之后焦点也落进问答框');
  // 117q-B3b 重钉：五态人话键从 stewardShell.drawer.state.* 搬到中性的 mission.state.*（30 号文 §4.4）。
  ok(onC && onC.state === zh['mission.state.needs_you'],
    `E3c 有待决时五态是「需要你」（实测「${onC && onC.state}」）`);
  ok(onC && onC.activityDoing.length > 0 && onC.activityDoing !== zh['stewardShell.drawer.none'],
    `E3d 三问的「在干什么」说出「等你」（实测「${onC && onC.activityDoing}」）`);
  ok(onC && onC.relayHidden === true, 'E3e C 自成事项，没有兄弟线程 → 接力关系整块隐藏');
  const killsBeforeC = auditRows().filter(row => row && row.kind === 'turn_kill' && row.sessionId === idC).length;
  await cdp.evaluate(`[...document.querySelectorAll('#stewardDrawerAskOptions .steward-drawer-reply')]
    .find(node => node.textContent.trim() === 'Vue').click(), true`);
  const cleared = await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return !pending.some(item => item && item.type === 'question' && item.sessionId === idC);
  }, token);
  const afterAnswer = await cdp.evaluate(DRAWER);
  ok(Boolean(cleared), `E4 点一条选项按钮 → 该待决消失（抽屉回执 ${JSON.stringify(afterAnswer && afterAnswer.note)}）`);
  ok(afterAnswer && afterAnswer.note === zh['stewardShell.drawer.answered'], 'E4b 抽屉给出「已替你回复」的回执');
  ok(auditRows().filter(row => row && row.kind === 'turn_kill' && row.sessionId === idC).length === killsBeforeC,
    'E4c 回答不 supersede 那个回合（该线程零新增 turn_kill）');
  const continuedC = await waitForHttp(appPort, 'GET', `/api/sessions/${idC}`, result => {
    const messages = (result.json && result.json.session && result.json.session.messages) || [];
    return messages.some(message => message && message.role === 'assistant' && String(message.content || '').includes('就按这个来'));
  }, token);
  ok(Boolean(continuedC), 'E4d 答完那条线程的回合接着往下跑（不是被杀掉之后重开）');
  const goneC = await waitForEval(cdp, `(() => {
    const snapshot = ${DRAWER};
    return snapshot.askHidden === true ? snapshot : null;
  })()`);
  ok(Boolean(goneC), 'E4e 答完之后 ④「它在问你」自己消失（没人在问了就不该留在屏幕上）');

  // ─── 117l D4：问答卡的【自由回答】（textarea ＋「回答」）走 /api/chat/answer 的 otherText ────
  // 用户第四轮走查①的原话是「没法正常地回复」—— 只有几枚候选按钮时，想说的话没有出口。
  // C 已经答完、回合收尾了，现在才轮到 D 起回合（见 A7 处的夹具说明：同工作区不并跑两条挂起的回合）。
  request(appPort, 'POST', '/api/chat/stream', { sessionId: idD, message: 'ask which framework', cwd: home }, token);
  const pendingD = await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return pending.some(item => item && item.type === 'question' && item.sessionId === idD);
  }, token);
  ok(Boolean(pendingD), 'E4f 线程 D 起了回合并挂在 request_user_input 上');
  await cdp.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: '${idD}' } })), true`);
  const onD = await waitForEval(cdp, `(() => {
    const snapshot = ${DRAWER};
    return snapshot.askHidden === false && snapshot.askLines.length ? snapshot : null;
  })()`);
  ok(Boolean(onD), 'E5 线程 D 也挂着一条 question 待决 → ④ 出现');
  if (!onD) console.log('DIAG onD=null 快照 ' + JSON.stringify(await cdp.evaluate(DRAWER)).slice(0, 600));
  // ── 117l D4（用户第四轮走查③「它刚说更新还是不够及时」）：在跑的回合看【活回合尾巴】────
  // D 的回合此刻还活着（挂在 request_user_input 上），服务端的 liveTail 里有它挂起前流出来的四句。
  ok(Boolean(onD) && onD.lastSayHead === zh['stewardShell.drawer.liveSay'],
    `E6 回合还活着 → 标题是「它正在说」（实测「${onD && onD.lastSayHead}」）`);
  ok(Boolean(onD) && onD.lastSay.indexOf(LIVE_TAIL3) === 0,
    `E6b 内容以活回合的【末尾】三句打头，不是开头（实测「${onD && onD.lastSay}」）`);
  ok(Boolean(onD) && onD.lastSay.indexOf('我先看了三个候选') < 0,
    'E6c 第一句被截掉 —— 活回合要看的是最新那几句（落盘原话那一路仍取开头，见 B10）');
  ok(Boolean(onD) && onD.lastSay.indexOf(zh['stewardShell.drawer.tool.askYou']) > 0
    && onD.lastSay.indexOf('request_user_input') < 0,
    `E6d 正在用的工具说【人话】，界面上不出现工具名（实测「${onD && onD.lastSay}」）`);
  const killsBeforeD = auditRows().filter(row => row && row.kind === 'turn_kill' && row.sessionId === idD).length;
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardDrawerAskInput');
    input.value = '都不用，就用原生的写';
    document.getElementById('stewardDrawerAskSendBtn').click();
    return true;
  })()`);
  const clearedD = await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return !pending.some(item => item && item.type === 'question' && item.sessionId === idD);
  }, token);
  ok(Boolean(clearedD), 'E5b 自由回答（不是候选里的任何一条）也能把待决答掉');
  ok(auditRows().filter(row => row && row.kind === 'turn_kill' && row.sessionId === idD).length === killsBeforeD,
    'E5c 自由回答同样【不】 supersede 那个回合（零新增 turn_kill）');
  const answeredD = await request(appPort, 'GET', `/api/sessions/${idD}`, null, token);
  const dMessages = (answeredD && answeredD.json && answeredD.json.session && answeredD.json.session.messages) || [];
  ok(dMessages.some(message => JSON.stringify(message || {}).indexOf('都不用，就用原生的写') >= 0),
    'E5d 用户写的那句话逐字进了会话（otherText，不是被折成某个选项 id）');

  // ─── 117l D2：「直接对这条线程说」走 /api/steward/relay 单口 ────────────────────
  // 修前抽屉自己猜通道：不 live 就直打 /api/chat/stream，撞上 09-workflow 的
  // `activeChildren.has → stopSession('superseded')`。现在只有一个口子，通道由服务端判。
  // B 是空闲线程 → 服务端判 turn 通道 → 那句话真的进了 B 的会话并开出一个回合。
  // 此刻抽屉停在 D（自成事项，页签里没有 B），所以换线程走 focus-thread 事件而不是点页签。
  await cdp.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: '${idB}' } })), true`);
  await waitForEval(cdp, `(() => (${DRAWER}).title === ${JSON.stringify(THREAD_B)} || null)()`);
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardDrawerInput');
    input.value = '直接对这条线程说一句';
    document.getElementById('stewardDrawerSendBtn').click();
    return true;
  })()`);
  const relayedToB = await waitForHttp(appPort, 'GET', `/api/sessions/${idB}`, result => {
    const messages = (result.json && result.json.session && result.json.session.messages) || [];
    return messages.some(message => message && message.role === 'user' && String(message.content || '').includes('直接对这条线程说一句'));
  }, token);
  ok(Boolean(relayedToB), 'E7 底部「直接对这条线程说」把话真的送进了那条线程（relay 的 turn 通道）');
  const noteAfterRelay = await waitForEval(cdp, `(() => {
    const snapshot = ${DRAWER};
    return snapshot.note ? snapshot : null;
  })()`);
  ok(Boolean(noteAfterRelay) && noteAfterRelay.note === zh['stewardShell.drawer.sent'],
    `E7b 回执按服务端回的 channel 说话（空闲线程 → 「已发给它」；实测「${noteAfterRelay && noteAfterRelay.note}」）`);
  ok(auditRows().filter(row => row && row.kind === 'turn_kill' && row.sessionId === idB).length === 0,
    'E7c 这条路上零 turn_kill');

  // ── H F3（32 号文 §2.2）：右栏变成「现在这几件」之后，抽屉【仍然只有一份】────────────────
  // 这一刀最容易破坏的就是本件的头号纪律：右栏叠起小行之后，很容易有人顺手把抽屉的区块复制一份
  // 进小行里（「小卡也要有它刚说、也要有回答框」）。那样壳里就有了两份抽屉渲染与两个输入框。
  // 判据不看小行长什么样，只看两件事：整页 id 以 stewardDrawer 开头的节点【全部】在同一棵
  // #stewardDrawer 子树里；右栏的小行里一个抽屉区块 id 都没有（区块清单取自模块导出的冻结表）。
  const NOW_STACK = `(() => {
    const body = document.getElementById('stewardNowBody');
    const drawer = document.getElementById('stewardDrawer');
    if (!body || !drawer) return null;
    const rows = [...body.querySelectorAll('.steward-now-thread')];
    const ids = ${JSON.stringify(['stewardDrawerMission', 'stewardDrawerTabs', 'stewardDrawerHead', 'stewardDrawerAsk',
    'stewardDrawerChips', 'stewardDrawerLastSay', 'stewardDrawerQuickReplies', 'stewardDrawerMore',
    'stewardDrawerRelay', 'stewardDrawerActivity', 'stewardDrawerAcceptance', 'stewardDrawerScene',
    'stewardDrawerFoot'])};
    return {
      rows: rows.length,
      blocksInRows: rows.reduce((sum, row) => sum + ids.filter(id => row.querySelector('#' + id)).length, 0),
      inputsInRows: rows.reduce((sum, row) => sum + row.querySelectorAll('textarea, input').length, 0),
      strays: [...document.querySelectorAll('[id^="stewardDrawer"]')].filter(node => node !== drawer && !drawer.contains(node)).length,
      drawerParent: drawer.parentElement ? drawer.parentElement.id : '',
    };
  })()`;
  const oneDrawer = await waitForEval(cdp, `(() => {
    const snapshot = ${NOW_STACK};
    return snapshot && snapshot.rows > 0 ? snapshot : null;
  })()`) || await cdp.evaluate(NOW_STACK);
  ok(Boolean(oneDrawer) && oneDrawer.rows > 0 && oneDrawer.drawerParent === 'stewardNowBody',
    `H1 右栏叠着小行，抽屉那一份仍然是搬进 #stewardNowBody 的【同一个】节点（实测 ${oneDrawer && oneDrawer.rows} 条小行，parent=${oneDrawer && oneDrawer.drawerParent}）`);
  ok(oneDrawer && oneDrawer.blocksInRows === 0 && oneDrawer.inputsInRows === 0 && oneDrawer.strays === 0,
    `H1b 小行里零抽屉区块、零输入框，整页也没有第二处 #stewardDrawer* 节点（实测 区块 ${oneDrawer && oneDrawer.blocksInRows}／输入框 ${oneDrawer && oneDrawer.inputsInRows}／游离 ${oneDrawer && oneDrawer.strays}）`);

  // ── ⑧ Esc 关闭 ─────────────────────────────────────────────────────────────
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
  const closed = await waitForEval(cdp, `(() => {
    const snapshot = ${DRAWER};
    return snapshot.hidden === true ? snapshot : null;
  })()`);
  ok(Boolean(closed), 'F1 Esc 关闭抽屉');
  ok(closed && closed.shellDrawer === '', 'F1b 关闭后管家壳不再让出右栏');
  ok(closed && closed.intervals.filter(ms => ms === TICK_MS).length === 1,
    `F2 关抽屉即停表，只剩 avatar 那一个轮询（实测 ${closed && JSON.stringify(closed.intervals)}）`);

  // ── ⑨ 切回经典壳：零残留定时器 ──────────────────────────────────────────────
  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgShellMode');
    select.value = 'classic';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const classic = await waitForEval(cdp, `(() => {
    const snapshot = ${DRAWER};
    return document.documentElement.getAttribute('data-shell-mode') === 'classic' ? snapshot : null;
  })()`);
  ok(Boolean(classic) && classic.intervals.filter(ms => ms === TICK_MS).length === 0,
    `G1 切回经典壳后管家侧零残留定时器（实测 ${classic && JSON.stringify(classic.intervals)}）`);
  ok(Boolean(classic) && classic.hidden === true, 'G2 抽屉在经典壳里保持关闭');
} catch (error) {
  console.log('ERROR ' + (error && error.stack || error));
  fail += 1;
} finally {
  if (cdp && fail) console.log('CONSOLE ' + cdp.logs.slice(-6).join(' | '));
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  if (provider) await new Promise(resolve => provider.close(resolve));
  await sleep(300);
  stopRuyiTestBrowsers(profile);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* browser profile lock */ }
  console.log(`\nSTEWARD DRAWER E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
