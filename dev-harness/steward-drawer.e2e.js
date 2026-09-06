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
// A 的最后一条助手消息：四句，末句是问句。抽屉只该显示前三句（§8.13「≤3 句」）。
const A_REPLY = '我先看了一眼报表。三个区的数字都对上了。差的是华南那张表。要不要我把汇总也做了？';
const A_FIRST3 = '我先看了一眼报表。三个区的数字都对上了。差的是华南那张表。';
const POLL_MS = 120000;   // 轮询周期拉满：测试窗口内不会自己 tick，计时器只按周期数个数

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
    const answered = messages.some(message => message && message.role === 'tool' && /Vue|React/.test(String(message.content || '')));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const sse = value => res.write('data: ' + JSON.stringify(value) + '\n\n');
    if (wantsQuestion && !answered) {
      const args = JSON.stringify({ questions: [{
        id: 'framework', header: 'Framework', question: '接着用哪个框架？', answerMode: 'single',
        options: [{ id: 'react', label: 'React' }, { id: 'vue', label: 'Vue' }],
      }] });
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
  const ids = ['stewardDrawerMission','stewardDrawerTabs','stewardDrawerHead','stewardDrawerChips',
    'stewardDrawerLastSay','stewardDrawerQuickReplies','stewardDrawerRelay','stewardDrawerActivity',
    'stewardDrawerAcceptance','stewardDrawerScene','stewardDrawerFoot'];
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
    replies: [...document.querySelectorAll('#stewardDrawerQuickRepliesRow .steward-drawer-reply')].map(node => node.textContent.trim()),
    replyKinds: [...document.querySelectorAll('#stewardDrawerQuickRepliesRow .steward-drawer-reply')].map(node => node.dataset.replyKind),
    relayHidden: document.getElementById('stewardDrawerRelay') ? document.getElementById('stewardDrawerRelay').hidden : null,
    relay: [...document.querySelectorAll('#stewardDrawerRelayList li')].map(node => node.textContent.trim()),
    acceptance: [...document.querySelectorAll('#stewardDrawerAcceptanceList li')].map(node => node.textContent.trim()),
    activityDoing: text('stewardDrawerActivityDoing'),
    activityWaiting: text('stewardDrawerActivityWaiting'),
    chipKeys: [...document.querySelectorAll('#stewardDrawerChips .steward-chip')].map(node => node.dataset.chip),
    chipValues: [...document.querySelectorAll('#stewardDrawerChips .steward-chip .steward-chip-value')].map(node => node.textContent.trim()),
    confirmVisible: document.querySelectorAll('#stewardDrawerChips .steward-chip-confirm').length,
    confirmLines: [...document.querySelectorAll('#stewardDrawerChips .steward-chip-confirm li')].map(node => node.textContent.trim()),
    note: text('stewardDrawerNote'),
    intervals: window.__ruyiLiveIntervals ? window.__ruyiLiveIntervals() : [],
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-drawer-'));
const home = path.join(root, 'home');
const profile = path.join(root, 'profile');
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
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200)), 'A1 workbench started');

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
  const idA = createdA && createdA.json && createdA.json.session && createdA.json.session.id;
  const idB = createdB && createdB.json && createdB.json.session && createdB.json.session.id;
  const idC = createdC && createdC.json && createdC.json.session && createdC.json.session.id;
  ok(Boolean(idA && idB && idC), `A3 三条线程已建（${idA || '失败'} / ${idB || '失败'} / ${idC || '失败'}）`);
  if (!idA || !idB || !idC) throw new Error('session fixtures unavailable');

  // 会话头的 mission 账本：kind 翻 'mission'（否则不进 /api/missions 的投影），并给两条里程碑 ——
  // 抽屉 ⑨ 验收项读的是这一份（GET /api/missions/:id 的 snapshot.acceptance.items）。
  for (const [id, goal] of [[idA, '把季度报表汇总出来'], [idB, '把素材归档'], [idC, '定下前端框架']]) {
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
  ok(openedA.ordered === true, 'B3 十一个区块的 DOM 顺序 === §8.13 的契约顺序');
  ok(openedA.shellDrawer === 'open', 'B4 宽屏下管家壳被标为 drawer=open（对话区收窄，抽屉占右侧 390px 栏）');
  ok(openedA.ariaModal === null, 'B4b 1440px 宽屏是栏式，不加 aria-modal');
  ok(openedA.tablist === 'tablist' && openedA.tabRoles === 2,
    `B5 线程页签是 tablist，两条兄弟线程各一个 tab（实测 ${openedA.tabRoles}）`);
  ok(openedA.tabs.length === 3 && openedA.tabs[2] === zh['stewardShell.drawer.newThread'],
    `B5b 页签行末尾是「＋ 线程」（实测 ${JSON.stringify(openedA.tabs)}）`);
  // 事项【容器】标题不在 GET /api/missions 的行里（本波交付记录登记项：那条路由返回的是线程行）。
  // 抽屉按确定性顺序回落到本线程标题 —— 断言钉的是这条回落，不是「显示容器名」。
  ok(openedA.missionTitle === THREAD_A,
    `B6 事项行显示事项名（容器标题无 HTTP 面时确定性回落为本线程标题，实测「${openedA.missionTitle}」）`);
  ok(openedA.missionAcceptance === zh['stewardShell.drawer.acceptanceCount'].replace('{{done}}', '1').replace('{{total}}', '2'),
    `B7 事项行显示验收 a/b（实测「${openedA.missionAcceptance}」）`);
  ok(openedA.title === THREAD_A, `B8 线程头显示线程标题（实测「${openedA.title}」）`);
  // 五态取 mission-state.js 的 fromCard（全仓唯一判据）。卡片投影不带 turnSeq，跑过 chat 回合但没有
  // agent run、没有里程碑完成的 mission 会话按那份判据就是「交办中」—— 抽屉如实照搬，不另编一套。
  const STATE_LABELS = ['dispatching', 'running', 'needs_you', 'done', 'stopped', 'quick_ask']
    .map(value => zh[`stewardShell.drawer.state.${value}`]);
  ok(STATE_LABELS.includes(openedA.state),
    `B9 线程头显示五态人话，且落在 mission-state.js 的枚举里（实测「${openedA.state}」）`);
  ok(openedA.lastSay === A_FIRST3,
    `B10 「它刚说」＝最后一条助手消息原话的前 3 句（实测「${openedA.lastSay}」）`);
  ok(!openedA.lastSay.includes('要不要我把汇总也做了'), 'B10b 第四句被截掉（≤3 句，不是全文）');
  ok(openedA.replies.length === 2
    && openedA.replies[0] === zh['stewardShell.drawer.reply.yes']
    && openedA.replies[1] === zh['stewardShell.drawer.reply.no'],
    `B11 A 无待决、末句是问句 → 「你可以说」给「好，就这样」「先不要」（实测 ${JSON.stringify(openedA.replies)}）`);
  ok(openedA.relayHidden === false && openedA.relay.length === 1 && openedA.relay[0].includes(THREAD_B),
    `B12 接力关系列出同事项的另一条线程（实测 ${JSON.stringify(openedA.relay)}）`);
  ok(openedA.acceptance.length === 2 && openedA.acceptance[0].includes('三个区'),
    `B13 验收项来自任务快照（实测 ${JSON.stringify(openedA.acceptance)}）`);
  ok(JSON.stringify(openedA.chipKeys) === JSON.stringify(['permission', 'model', 'engine']),
    `B14 快切 chip 三个：权限／模型／引擎（实测 ${JSON.stringify(openedA.chipKeys)}）`);
  ok(openedA.chipValues[0] === zh['stewardShell.chips.followGlobal'],
    `B14b 权限 chip 初始是「跟随全局」（实测「${openedA.chipValues[0]}」）`);
  ok(openedA.intervals.filter(ms => ms === POLL_MS).length === 2,
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
  ok(onC && JSON.stringify(onC.replies) === JSON.stringify(['React', 'Vue']),
    `E3 「你可以说」来自待决 question 的候选答案（实测 ${onC && JSON.stringify(onC.replies)}）`);
  ok(onC && onC.replyKinds.every(kind => kind === 'question'), 'E3b 这两条的 kind 是 question（走 /api/chat/answer）');
  ok(onC && onC.state === zh['stewardShell.drawer.state.needs_you'],
    `E3c 有待决时五态是「需要你」（实测「${onC && onC.state}」）`);
  ok(onC && onC.activityDoing.length > 0 && onC.activityDoing !== zh['stewardShell.drawer.none'],
    `E3d 三问的「在干什么」说出「等你」（实测「${onC && onC.activityDoing}」）`);
  ok(onC && onC.relayHidden === true, 'E3e C 自成事项，没有兄弟线程 → 接力关系整块隐藏');
  await cdp.evaluate(`[...document.querySelectorAll('#stewardDrawerQuickRepliesRow .steward-drawer-reply')]
    .find(node => node.textContent.trim() === 'Vue').click(), true`);
  const cleared = await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return !pending.some(item => item && item.type === 'question' && item.sessionId === idC);
  }, token);
  const afterAnswer = await cdp.evaluate(DRAWER);
  ok(Boolean(cleared), `E4 点一条「你可以说」（question 选项）→ 该待决消失（抽屉回执 ${JSON.stringify(afterAnswer && afterAnswer.note)}）`);
  ok(afterAnswer && afterAnswer.note === zh['stewardShell.drawer.answered'], 'E4b 抽屉给出「已替你回复」的回执');

  // ── ⑧ Esc 关闭 ─────────────────────────────────────────────────────────────
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
  const closed = await waitForEval(cdp, `(() => {
    const snapshot = ${DRAWER};
    return snapshot.hidden === true ? snapshot : null;
  })()`);
  ok(Boolean(closed), 'F1 Esc 关闭抽屉');
  ok(closed && closed.shellDrawer === '', 'F1b 关闭后管家壳不再让出右栏');
  ok(closed && closed.intervals.filter(ms => ms === POLL_MS).length === 1,
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
  ok(Boolean(classic) && classic.intervals.filter(ms => ms === POLL_MS).length === 0,
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
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* browser profile lock */ }
  console.log(`\nSTEWARD DRAWER E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
