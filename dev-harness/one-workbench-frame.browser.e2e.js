#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）

// 121 波 K4 真浏览器 E2E：一台两视的【外框】（34 号文 §2.2／§2.3／§2.7／§2.9／§7.1／§7.3）。
//
// 这一件钉的是「一台两视」这句话本身能不能兑现 —— 十组事实，每组都是「切换前后／断点前后
// 屏幕上真的是那样」，全部读 DOM 与计算样式，一个模块私有状态都不碰：
//   ① 左栏是【同一份 DOM】：切视角前后 #sidebar／#railList／#sessionSearch 都 isSameNode（§2.1 第 10 条）；
//   ② 1920 三栏在位、中栏读宽 ≤880（§7.1），且两个视角的三栏栅格【逐字相同】（切换不跳）；
//   ③ 1200／900 两个断点：1200 右栏仍在栅格里、900 左栏折成 56px 图标栏且行一条不少（§7.3），各存一张图；
//   ④ 切视角真的走 View Transitions：startViewTransition 一次切换【只调一次】，:root[data-vt]
//      方向正确（管家→工作台 fwd、回来 back），命名部件上真的跑了 vt-* 那几条 keyframes，收尾即删属性；
//   ⑤ prefers-reduced-motion: reduce 与【不支持 startViewTransition】两条路都是零动画即时切换（§2.9 末句）；
//   ⑥ 左栏按任务归五组、归组正确（等你／在跑／…）；
//   ⑦ 「＋」两义：管家视角＝把输入框目标切成「另起一件」并聚焦【不建会话】，工作台视角＝真建一条（§2.3）；
//   ⑧ 多线程任务是一行任务行＋展开容器，单线程任务不画任务层；
//   ⑨ 管家开出一条线程 → 左栏 ≤1 s 出现这一行（§6.3 指标 e 的同一条推送路，这里从【调用返回】起算）；
//   ⑩ §2.7 现场保持：两个视角各记自己的（管家＝焦点线程，工作台＝选中线程与对话流滚动位置），
//      切来切去互不清空；切换后焦点落在该视角自己的锚点上。
//
// 夹具：A 停在 question 待决（等你）、B 的回合一直挂着（在跑）、C 一句长回答收尾（今天收工）；
// A＋B 挂在同一个事项容器下（多线程任务），C 自成一件（单线程任务）。后端零改动。
// 与 steward-board.e2e.js／steward-drawer.e2e.js 同一套 CDP 无头驱动。
//
// 截图落点：默认在夹具临时目录，设了 RUYI_SHOT_DIR 就落到那里（交付报告要贴这两张）。
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
const zh = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const THREAD_A = '等华南的表';       // 停在 question 待决 → 等你
const THREAD_B = '跑批处理';         // 回合一直挂着 → 在跑
const THREAD_C = '选个框架';         // 一句长回答收尾 → 今天收工（⑩ 的滚动位置也用它）
const MISSION_TITLE = '季度收尾';    // A＋B 的事项容器（多线程任务）
const NEW_THREAD = '管家刚开的这一条'; // ⑨：管家自己开出来的那一条
const POLL_MS = 120000;              // 兜底节拍拉满：本件不测节拍，别让它插队重画
const NEW_ROW_BUDGET_MS = 1000;      // ⑨ 的预算（§6.3「≤1 s」）

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
    if (process.platform === 'win32') killOwnTree(child);
    else child.kill('SIGKILL');
  } catch { /* already exited */ }
}

// 确定性 provider：'ask' → 一条 request_user_input（挂成 question 待决）；'hang' → 只开流不收尾；
// 其余 → 一段【长】回答（⑩ 要对话流真的能滚，短回答撑不出滚动条）。
const openSockets = [];
const LONG_LINE = '这一段是为了把对话流撑高，好让「切视角不丢滚动位置」这件事有东西可量。';
async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    // 按【整份请求体里的标记】认这一支，不按「最后一条 user 消息」认：易变前缀会拼在首条 user
    // 消息前、工具结果会追在后面，「最后一条 user 消息」在第二个回合起就不一定是夹具那句话了
    // （第一轮实测 A5 偶发红：A 的那一发被认成了「普通长回答」，于是它没停在待决）。
    // 同一条会话的后续回合仍然命中同一支 —— 历史里那句话一直在，这正是我们要的确定性。
    // 认这一支只看夹具自己那两句【独一无二】的话（第一轮用「最后一条 user 消息」认，
    // 会被易变前缀与工具结果搅乱；第二轮直接按整份请求体里的 'ask'/'hang' 认，又把带着
    // request_user_input 工具表的每一发都认成 ask —— 两次都是判据不够独特）。
    const intent = raw.includes('hang here') ? 'hang' : (raw.includes('ask about south') ? 'ask' : 'long');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = payload => res.write('data: ' + JSON.stringify(payload) + '\n\n');
    if (intent.includes('ask')) {
      // 参数形状照抄 steward-board.e2e.js 那一份（questions[] ＋ options[{id,label}]）——
      // 第一轮我按「question/kind/options[string]」写，工具当场拒了参数，回合直接收尾，
      // 于是 A 停在 stopped 而不是等你（A5 偶发绿是因为那一次读到的是别的时刻）。
      const args = JSON.stringify({ questions: [{
        id: 'south', header: 'South', question: '华南那张表要等吗？', answerMode: 'single',
        options: [{ id: 'wait', label: '等' }, { id: 'skip', label: '不等' }],
      }] });
      frame({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_k4_q', type: 'function', function: { name: 'request_user_input', arguments: '' } }] }, finish_reason: null }] });
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (intent.includes('hang')) {
      openSockets.push(res);
      frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '在跑…' }, finish_reason: null }] });
      return;   // 刻意不收尾：这一条永远「在跑」
    }
    frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    for (let i = 0; i < 40; i++) frame({ choices: [{ index: 0, delta: { content: LONG_LINE + '（第 ' + (i + 1) + ' 段）\n\n' }, finish_reason: null }] });
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
  for (let i = 0; i < 200; i++) {
    const result = await request(debugPort, 'GET', '/json/list');
    const targets = result && Array.isArray(result.json) ? result.json : [];
    const target = targets.find(item => item.type === 'page' && String(item.url || '').startsWith(appUrl));
    if (target && target.webSocketDebuggerUrl) return target;
    await sleep(50);
  }
  return null;
}

// 预算 800 × 40ms = 32 s：并行全量下四个无头浏览器抢 CPU（与同族五件同一个数）。
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

// 就绪判据必须是【真 config 到达】：K0 的时序是 bind 期先 fail-closed 落 classic、config 到达后
// 才补判回 steward —— 用 state.config 的初值（{}，真值）当就绪，会在那段窗口里读到一个假的 classic。
const READY = `(() => {
  if (!window.state || !window.state.status || !window.state.config || !window.state.config.configSchema) return null;
  if (!document.getElementById('railList') || !document.getElementById('appFrame')) return null;
  const button = document.querySelector('#lensSeg [data-lens]');
  if (!button || typeof button.onclick !== 'function') return null;
  return { ready: true };
})()`;

const rectExpr = `node => { if (!node) return null; const b = node.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; }`;

// 外框快照：只读 DOM、公开属性与计算样式。
const FRAME = `(() => {
  const rect = ${rectExpr};
  const byId = id => document.getElementById(id);
  const cols = node => (node ? getComputedStyle(node).gridTemplateColumns : '');
  const body = document.querySelector('.app-body');
  const side = byId('stewardSide');
  return {
    mode: document.documentElement.getAttribute('data-shell-mode'),
    vt: document.documentElement.dataset.vt || '',
    iw: innerWidth,
    // 比「右栏滑出去了没有」这种位置事实要用【布局视口】宽，不是 innerWidth ——
    // 后者含滚动条（本机无头实测差 24px），第一轮 D5b 就是被这 24px 判红的。
    cw: document.documentElement.clientWidth,
    bodyCols: cols(body),
    shellCols: cols(document.querySelector('.app-shell')),
    stewardCols: cols(byId('stewardShell')),
    topbar: rect(document.querySelector('.app-topbar')),
    rail: rect(byId('sidebar')),
    stage: rect(byId('stewardStage')),
    feed: rect(byId('stewardFeed')),
    side: rect(side),
    sideHidden: side ? side.hidden : null,
    chat: rect(document.querySelector('.chat-pane')),
    tool: rect(byId('toolPane')),
    sideToggle: byId('appSideToggleBtn') ? getComputedStyle(byId('appSideToggleBtn')).display : '',
    plusLabel: (byId('newSessionBtnLabel') || {}).textContent || '',
    railCount: (byId('railCount') || {}).textContent || '',
    rows: document.querySelectorAll('#railList .steward-board-thread').length,
    taskRows: document.querySelectorAll('#railList .rail-task').length,
    titleDisplays: [...new Set([...document.querySelectorAll('#railList .steward-board-thread-title')]
      .map(node => getComputedStyle(node).display))],
    // ≤980 图标栏那一档的硬判据：左栏里【一个字都不该看得见】（§2.3 末条「只留每行那颗任务
    // 色点」）。只数真的画出来了的叶子节点（有字、display 不是 none、rect 有宽度）——
    // 祖先被收起的叶子 rect 会是 0，不会混进来。
    // 按【文字节点】数，不按「没有子元素的那些节点」数：药丸那种「字形 span ＋ 文字」的节点
    // 自己是有子元素的，按元素数会把它整条漏掉（第一轮就漏了：断言说 0 处残留，截图上
    // 明明还看得见「需要」「已停」两截字）。Range 量的是那段文字【真的画在哪儿】，
    // 祖先被 display:none 收起时它是 0×0。
    railVisibleText: (() => {
      const out = [];
      const rail = document.getElementById('sidebar');
      if (!rail) return out;
      const walker = document.createTreeWalker(rail, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = String(node.nodeValue || '').trim();
        if (!text) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) {
          const parent = node.parentElement;
          out.push(String((parent && parent.className) || 'text') + '「' + text.slice(0, 10) + '」');
        }
      }
      return out;
    })(),
    dotAfter: (() => {
      const head = document.querySelector('#railList .steward-board-thread-head');
      return head ? getComputedStyle(head, '::after').width : '';
    })(),
    selected: [...document.querySelectorAll('#railList .steward-board-thread.is-sel')].map(node => node.dataset.sessionId || ''),
    rowFacts: [...document.querySelectorAll('#railList .steward-board-thread')].map(node => ({
      id: node.dataset.sessionId || '',
      title: (node.querySelector('.steward-board-thread-title') || { textContent: '' }).textContent.trim(),
      state: node.dataset.state || '',
      group: node.closest('.rail-group') ? node.closest('.rail-group').dataset.group : '',
    })),
    composer: (() => {
      const input = document.getElementById('stewardComposerInput');
      const chip = document.getElementById('stewardTarget');
      return {
        input: Boolean(input),
        disabled: input ? input.disabled : null,
        chip: Boolean(chip),
        target: chip ? (chip.querySelector('.steward-target-label') || { textContent: '' }).textContent.trim() : '',
      };
    })(),
    groups: [...document.querySelectorAll('#railList .rail-group')].map(section => ({
      key: section.dataset.group || '',
      rows: [...section.querySelectorAll('.steward-board-thread')].map(node => node.dataset.sessionId || ''),
      tasks: [...section.querySelectorAll('.rail-task')].map(node => ({
        count: (node.querySelector('.rail-task-count') || {}).textContent || '',
        title: (node.querySelector('.steward-board-thread-title') || {}).textContent || '',
        threads: node.nextElementSibling && node.nextElementSibling.classList.contains('rail-threads')
          ? node.nextElementSibling.querySelectorAll('.steward-board-thread').length : -1,
      })),
      loneRows: [...(section.querySelector('.rail-tasks') || { children: [] }).children]
        .filter(node => node.classList.contains('steward-board-thread')).map(node => node.dataset.sessionId || ''),
    })),
    drawerTitle: (byId('stewardDrawerTitle') || {}).textContent || '',
    sessionTitle: (byId('sessionTitle') || {}).textContent || '',
    messagesScrollTop: byId('messages') ? Math.round(byId('messages').scrollTop) : -1,
    messagesOverflow: byId('messages') ? byId('messages').scrollHeight - byId('messages').clientHeight : -1,
    activeId: document.activeElement ? (document.activeElement.id || document.activeElement.className || '') : '',
    // 落焦【落在这个视角里】比「落在某一个固定 id 上」更是那条纪律的本意：applyShellMode 把
    // 焦点送到视角容器，随后视角自己的子域可以把它接走（管家侧：焦点卡开线程时会把光标送进
    // 那条线程的回答框 —— steward-drawer.js 的 focusAsk）。两者都算「焦点在管家这一侧」。
    activeInSteward: (() => {
      const shell = document.getElementById('stewardShell');
      const active = document.activeElement;
      return Boolean(shell && active && (shell === active || shell.contains(active)));
    })(),
    vtCalls: window.__vt ? window.__vt.calls : -1,
    vtDirs: window.__vt ? window.__vt.dirs.slice() : [],
    vtAnims: window.__vt ? window.__vt.anims.slice() : [],
    liveVtAnims: document.getAnimations()
      .filter(a => /^vt-/.test(String(a.animationName || ''))
        || String((a.effect && a.effect.pseudoElement) || '').includes('view-transition')).length,
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-one-workbench-frame-'));
const home = path.join(root, 'home');
const workA = path.join(root, 'work-a');
const workB = path.join(root, 'work-b');
const workC = path.join(root, 'work-c');
const profile = path.join(root, 'profile');
// 三条线程各自的工作文件夹：同 cwd 会撞上 116h 的写互斥，那不是本件要测的形状。
for (const dir of [home, workA, workB, workC]) fs.mkdirSync(dir, { recursive: true });
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

  const created = {};
  for (const [key, title, cwd] of [['A', THREAD_A, workA], ['B', THREAD_B, workB], ['C', THREAD_C, workC]]) {
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
    title: MISSION_TITLE, acceptance: [{ text: '汇总表交付', done: true }, { text: '对账通过', done: false }],
  }, token);
  const missionId = container && container.json && container.json.mission && container.json.mission.missionId;
  ok(Boolean(missionId), `A4 事项容器已建（${missionId || '失败'}）`);
  for (const id of [created.A, created.B]) {
    await request(appPort, 'POST', `/api/missions/${encodeURIComponent(missionId)}/threads`, { action: 'attach', sessionId: id }, token);
  }

  // C 先跑完（长回答，⑩ 要它撑出滚动条）；A 停在待决；B 一直挂着。
  // 「要它活着」的那两发给 10 分钟：默认 20 s 一到 req.destroy() 会把服务端那一头的流掐断，
  // 回合随之结束 —— 那是夹具自己把回合掐了，不是产品行为（K4 修 steward-board.e2e 时的同一个坑）。
  await request(appPort, 'POST', '/api/chat/stream', { sessionId: created.C, message: 'long answer please', cwd: workC }, token, 600000);
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.A, message: 'ask about south', cwd: workA }, token, 600000);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return pending.some(item => item && item.type === 'question' && item.sessionId === created.A);
  }, token)), 'A5 线程 A 停在 question 待决（等你）');
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.B, message: 'hang here', cwd: workB }, token, 600000);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === created.B);
    return Boolean(row && row.activeTurn === true);
  }, token)), 'A6 线程 B 的回合一直在飞（在跑）');

  const executable = findBrowserExecutable();
  ok(Boolean(executable), 'A7 Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1920,1080',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A8 browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // ④ 的探针：把 document.startViewTransition 包起来数调用、记方向、记【真的在跑的那几条动画】。
  // 必须在页面脚本之前装（addScriptToEvaluateOnNewDocument + reload）——晚一步就包不住第一次切换。
  // 这是「包住宿主 API 数事实」的既有手法（steward-board.e2e 数 setInterval 用的同一招）。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const native = typeof document.startViewTransition === 'function' ? document.startViewTransition.bind(document) : null;
      window.__vt = { calls: 0, dirs: [], anims: [], native: Boolean(native) };
      if (!native) return;
      const wrapper = callback => {
        window.__vt.calls += 1;
        const transition = native(callback);
        // 方向是【调用之前】写在 :root 上的，所以这里读到的就是这一次用的那个值。
        window.__vt.dirs.push(String(document.documentElement.dataset.vt || ''));
        try {
          transition.ready.then(() => {
            window.__vt.anims.push(document.getAnimations()
              .map(a => String(a.animationName || '')).filter(Boolean).sort().join(','));
          }, () => {});
        } catch { /* ready 不可用不影响切换本身 */ }
        return transition;
      };
      document.startViewTransition = wrapper;
      window.__vtSupported = on => { document.startViewTransition = on ? wrapper : undefined; return on; };
      window.__vtReset = () => { window.__vt.calls = 0; window.__vt.dirs.length = 0; window.__vt.anims.length = 0; return true; };
    })();`,
  });
  await cdp.evaluate('location.reload(); true');
  ok(Boolean(await waitForEval(cdp, READY)), 'A9 首屏就绪（config 真到达、外框与左栏在位、分段钮已接线）');
  ok(Boolean(await waitForEval(cdp, 'window.__vt && window.__vt.native ? 1 : null')),
    'A10 View Transitions 探针已装上，且这个浏览器【原生支持】startViewTransition（不支持的那一支由 ⑤ 单独走）');
  const rowsReady = `(() => document.querySelectorAll('#railList .steward-board-thread').length >= 3 ? 1 : null)()`;
  ok(Boolean(await waitForEval(cdp, rowsReady)), 'A11 左栏把三条线程都画出来了（常开，不用先点开）');

  const setLens = async lens => {
    await cdp.evaluate(`(document.querySelector('#lensSeg [data-lens="${lens}"]') || { click() {} }).click(), true`);
    return waitForEval(cdp, `(() => document.documentElement.getAttribute('data-shell-mode') === '${lens}'
      && !document.documentElement.dataset.vt ? 1 : null)()`);
  };
  const snap = () => cdp.evaluate(FRAME);

  /* ═════════ ① 左栏是同一份 DOM（§2.1 第 10 条 / §2.3）═════════
     反向验证：把 index.html 里的 #sidebar 复制成两份、各放进一个视角容器 → B1 当场红
     （两次拿到的不是同一个节点）。K4-1 落地前这一件就是那个形状：会话列表在 2.0 的侧栏里、
     线程行在管家看板浮层里，「同一份」根本无从谈起。 */
  await cdp.evaluate(`(window.__k4 = {
    rail: document.getElementById('sidebar'),
    list: document.getElementById('railList'),
    search: document.getElementById('sessionSearch'),
    firstRow: document.querySelector('#railList .steward-board-thread'),
  }, true)`);
  // 123-M3（37 号文 §3.7 连带修正）：C1b 靠的是「刚进管家视角、焦点还没算出来」那个真实但很窄的
  // 窗口——steward-board.js 的 enterSteward() 是 fire-and-forget，它的 refreshBoard() 要
  // loadMissions()＋loadArbiter() 两趟网络往返都回来才会跑 syncNow() 把右栏翻出来。这张
  // 「空右栏」快照必须在下面新加的 B0 等待【之前】就拍下来——晚一步（哪怕只是为了等 B0 的
  // shell-mode 稳定）就足够那条 fire-and-forget 链子跑完，右栏悄悄有了焦点，C1b 就会假红
  // （本波实测：加完 B0 的等待后 C1b 从 3/3 绿变 2/2 红，退回原始顺序复测确认二者互不相干）。
  const emptySide = await snap();
  // 123-M3（37 号文 §3.7）：B0 偶红的签名与 quiet-card A0g2 一致——READY 只要求 state.config 在，
  // 而默认落点那次 applyShellMode('steward') 的写回调可能被 View Transitions 推迟一帧；快照读
  // 在它落地之前就会撞见还没翻过来的临时值（单跑复现过一次：before.mode 读到 classic）。等
  // data-shell-mode 连续 10 次×50 ms 采样不变，再读第一张快照——不预判它该稳定成什么，只等它
  // 不再变（写法抄 quiet-card.browser.e2e.js 的 A0g2 段）。
  {
    let prev = await cdp.evaluate(`(() => document.documentElement.getAttribute('data-shell-mode'))()`);
    let stable = 0;
    for (let i = 0; i < 400 && stable < 10; i++) {
      await sleep(50);
      const cur = await cdp.evaluate(`(() => document.documentElement.getAttribute('data-shell-mode'))()`);
      if (cur === prev) { stable += 1; } else { stable = 0; prev = cur; }
    }
  }
  const before = await snap();
  ok(before.mode === 'steward', `B0 默认视角是管家（K0 的默认入口；实测 ${before.mode}）`);
  await setLens('classic');
  const same = await cdp.evaluate(`(() => ({
    rail: document.getElementById('sidebar').isSameNode(window.__k4.rail),
    list: document.getElementById('railList').isSameNode(window.__k4.list),
    search: document.getElementById('sessionSearch').isSameNode(window.__k4.search),
    railCount: document.querySelectorAll('#sidebar').length,
    listCount: document.querySelectorAll('#railList').length,
    inBody: document.getElementById('sidebar').parentElement.classList.contains('app-body'),
  }))()`);
  ok(same.rail === true && same.list === true && same.search === true,
    `B1 切到工作台之后，左栏／行容器／搜索框都还是【同一个节点】（isSameNode：${same.rail}／${same.list}／${same.search}）`);
  ok(same.railCount === 1 && same.listCount === 1 && same.inBody === true,
    'B1b 整个文档里只有一份左栏，而且它挂在外框的 .app-body 上（不在任何一个视角容器里）');
  await setLens('steward');
  const backSame = await cdp.evaluate(`document.getElementById('sidebar').isSameNode(window.__k4.rail)`);
  ok(backSame === true, 'B2 切回管家之后仍是同一个节点（来回两趟都不重建）');

  /* ═════════ ② 1920 三栏与中栏读宽（§7.1）═════════
     反向验证：把 steward-shell.css 里 .app-views > .steward-shell 的列宽从 var(--right-w) 改成
     别的值 → C3 当场红（两个视角的栅格不再逐字相同，切换会跳一次宽度）。
     emptySide 复用最上面那张【进壳即拍】的快照，不在这里重新 snap()——见上面 123-M3 的登记。 */
  ok(emptySide.topbar && emptySide.topbar.h === 46 && emptySide.topbar.y === 0,
    `C1 顶栏 46px 贴在最上面（实测 ${emptySide.topbar && emptySide.topbar.h}px @ y=${emptySide.topbar && emptySide.topbar.y}）`);
  // 右栏【空着的时候不占一条空白轨】（K4-1 那条 :has(> .steward-side[hidden]) 规则）：管家视角
  // 刚进来还没有焦点线程，那一栏是 hidden，中栏就该铺满剩下的宽度。右栏里放什么归 K6，
  // 所以这里只钉「空就收、有焦点就 392」这件外框自己的事。
  ok(emptySide.sideHidden === true && emptySide.side.w === 0
    && Math.abs((emptySide.rail.w + emptySide.stage.w) - emptySide.cw) <= 1,
    `C1b 右栏空着时不占轨：左栏 ${emptySide.rail.w} ＋ 中栏 ${emptySide.stage.w} ＝ 布局视口 ${emptySide.cw}`);
  // 点一行 → 右栏有了焦点线程，三栏才真的都在。
  await cdp.evaluate(`(() => {
    const row = document.querySelector('#railList .steward-board-thread[data-session-id="${created.A}"] .steward-board-thread-title');
    if (row) row.click();
    return true;
  })()`);
  // 右栏那一格的列宽【是过渡的】（steward-shell.css 给 grid-template-columns 上了 --dur-fast
  // 的过渡）。第一轮就在动画中途量到了 381.83px，于是「两个视角栅格逐字相同」被判红 ——
  // 红的不是产品，是量的时机。等它真的落定（≥390px）再多给两帧。
  await waitForEval(cdp, `(() => {
    const side = document.getElementById('stewardSide');
    return side && !side.hidden && side.getBoundingClientRect().width >= 390 ? 1 : null;
  })()`);
  await sleep(300);
  const wide = await snap();
  ok(wide.rail && wide.rail.w === 268 && wide.rail.x === 0
    && wide.stage && wide.stage.x === 268 && wide.side && wide.side.w > 0
    && Math.abs((wide.stage.x + wide.stage.w) - wide.side.x) <= 1,
    `C2 1920 下三栏在位且首尾相接：左栏 ${wide.rail && wide.rail.w} ｜ 中栏 ${wide.stage && wide.stage.w} ｜ 右栏 ${wide.side && wide.side.w}`);
  // W4b 重钉（用户 2026-09-25 走查③「右栏展开时对话贴左、收起时居中」）：读宽从 880 收成 720 —— 880 比右栏
  // 展开时中栏能给的宽还大，展开态是铺满贴边、收起态才居中，两态看着是两种版式；720 在两态里都装得下，
  // 于是永远是同一条居中的对话列（steward-shell.css 的 --steward-col-w，一个 token）。管家的话本来就 ≤680、
  // 用户气泡 ≤520，正文一个字没被削。反向：把 --steward-col-w 改回 880px → 本条红。
  ok(wide.feed && wide.feed.w === 720,
    `C2b 中栏内容读宽 = 720（--steward-col-w；实测 ${wide.feed && wide.feed.w}px，居中留白由 margin-inline:auto 给，右栏展开／收起两态同宽）`);
  await setLens('classic');
  const wideClassic = await snap();
  ok(wideClassic.shellCols === wide.stewardCols,
    `C3 两个视角的三栏栅格【逐字相同】（管家 ${wide.stewardCols} ／ 工作台 ${wideClassic.shellCols}）—— 切换时栅格一动不动`);
  ok(wideClassic.rail && wideClassic.rail.w === wide.rail.w
    && wideClassic.chat && Math.abs(wideClassic.chat.w - wide.stage.w) <= 1
    && wideClassic.tool && Math.abs(wideClassic.tool.w - wide.side.w) <= 1,
    `C3b 三栏的实际像素宽也逐字相同（左 ${wideClassic.rail.w}／中 ${wideClassic.chat.w}／右 ${wideClassic.tool.w}）`);
  // 备查（不作断言）：§7.1 末句「≥1600 右栏放宽到 440」今天【到不了】—— 2.0 的 restoreRightWidth()
  // 在启动时就把 --right-w 写成 .app-body 的内联 392px，内联永远压过容器查询那一条。
  // 右栏归 K6，那一刀把档位与断点合成一处时再决；这里如实记下实测值。
  console.log(`NOTE 右栏实测 ${wide.side.w}px @1920（容器查询里的 440 被 2.0 的内联档位压着，留给 K6）`);

  /* ═════════ ③ 1200／900 两个断点（§7.3）═════════
     反向验证：把 layout.css 的 @container frame (max-width: 980px) 那一档删掉 → D4/D5 当场红
     （左栏还是 268px、行里的字也没收起）。两张图存下来是给人看的，断言不看图。 */
  const shots = {};
  const resize = async (width, height) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
  };
  await resize(1200, 900);
  const at1200 = await snap();
  ok(at1200.rail && at1200.rail.w === 268 && at1200.tool && at1200.tool.w > 0
    && at1200.sideToggle === 'none',
    `D1 1200：左栏 268、右栏仍在栅格里（${at1200.tool && at1200.tool.w}px）、顶栏不出「右栏」钮（实测 display=${at1200.sideToggle}）`);
  const fixtureRows = snapshot => [created.A, created.B, created.C]
    .every(id => snapshot.rowFacts.some(row => row.id === id));
  ok(fixtureRows(at1200) && at1200.titleDisplays.every(value => value !== 'none'),
    `D2 1200：三条夹具线程都在（左栏共 ${at1200.rows} 行 = 1 行任务行 ＋ 3 条线程行：${at1200.rowFacts.map(r => r.title).join('、')}），行里的字都还印着（${at1200.titleDisplays.join('/')}）`);
  shots.wide1200 = path.join(shotDir, 'k4-frame-1200.png');
  fs.writeFileSync(shots.wide1200, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  ok(fs.statSync(shots.wide1200).size > 8000, `D3 1200 断点截图已存（${shots.wide1200}）`);

  await resize(900, 900);
  const at900 = await snap();
  ok(at900.rail && at900.rail.w === 56,
    `D4 900：左栏折成 56px 图标栏（实测 ${at900.rail && at900.rail.w}px）`);
  ok(at900.rows === at1200.rows && fixtureRows(at900)
    && at900.titleDisplays.length === 1 && at900.titleDisplays[0] === 'none'
    && at900.dotAfter === '10px',
    `D5 900：行一条不少（${at900.rows} 条，与 1200 那一档逐条相同，DOM 一个节点没删），只是字收起、每行留一颗 ${at900.dotAfter} 的任务色点`);
  // display 的【计算值】是 grid 不是 inline-grid：顶栏是 flex 容器，行内级会被块化
  // （CSS Display 3 的 blockify）。这里钉「它出来了」，形状本身由 D7 那一下点击兑现。
  ok(at900.sideToggle === 'grid' && at900.tool && at900.tool.w > 0
    && at900.tool.x >= at900.cw - 1,
    `D5b 900：右栏离开栅格、滑到屏幕外等着（x=${at900.tool && at900.tool.x} ≥ 布局视口 ${at900.cw}），顶栏出「右栏」钮（display=${at900.sideToggle}）`);
  ok(at900.railVisibleText.length === 0,
    `D5c 900：左栏里一个字都看不见了（§2.3「只留每行那颗任务色点」；实测残留 ${at900.railVisibleText.length} 处${at900.railVisibleText.length ? '：' + at900.railVisibleText.join('、') : ''}）`);
  shots.narrow900 = path.join(shotDir, 'k4-frame-900.png');
  fs.writeFileSync(shots.narrow900, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  ok(fs.statSync(shots.narrow900).size > 8000, `D6 900 断点截图已存（${shots.narrow900}）`);
  await cdp.evaluate(`(document.getElementById('appSideToggleBtn') || { click() {} }).click(), true`);
  const opened = await waitForEval(cdp, `(() => {
    const pane = document.getElementById('toolPane');
    if (!pane) return null;
    const box = pane.getBoundingClientRect();
    return box.right <= innerWidth + 1 && box.left < innerWidth - 100 ? Math.round(box.left) : null;
  })()`);
  ok(Boolean(opened), `D7 900：点顶栏「右栏」钮，右栏真的滑进来（left=${opened}）`);
  await resize(1920, 1080);
  await setLens('steward');

  /* ═════════ ④ 切视角真的走 View Transitions（§2.9）═════════
     反向验证：把 shell-mode.js 的 applyShellMode 改回「直接 setAttribute」→ E1 当场红
     （calls 仍是 0）；把 layout.css 里 ::view-transition-old(center) 那几条删掉 → E3 红
     （过渡起了，但命名部件上一条 vt-* 都没跑）。 */
  await cdp.evaluate('window.__vtReset()');
  await setLens('classic');
  const fwd = await snap();
  ok(fwd.vtCalls === 1, `E1 一次切换只调一次 startViewTransition（实测 ${fwd.vtCalls}）`);
  ok(fwd.vtDirs.length === 1 && fwd.vtDirs[0] === 'fwd',
    `E2 管家 → 工作台是【前进】方向：调用时 :root[data-vt]="${fwd.vtDirs[0]}"`);
  ok(fwd.vtAnims.length === 1 && /vt-out-l/.test(fwd.vtAnims[0]) && /vt-in-r/.test(fwd.vtAnims[0]),
    `E3 命名部件上真的跑了那几条 keyframes（旧帧向左出、新帧从右进；实测 ${fwd.vtAnims[0]}）`);
  ok(fwd.vt === '' && fwd.liveVtAnims === 0,
    'E4 收尾即删：动画跑完 :root 上不留 data-vt，也不剩任何 view-transition 动画');
  await cdp.evaluate('window.__vtReset()');
  await setLens('steward');
  const back = await snap();
  ok(back.vtCalls === 1 && back.vtDirs[0] === 'back',
    `E5 工作台 → 管家是【返回】方向（calls=${back.vtCalls}，data-vt=${back.vtDirs[0]}）`);
  ok(back.vtAnims.length === 1 && /vt-out-r/.test(back.vtAnims[0]) && /vt-in-l/.test(back.vtAnims[0]),
    `E6 返回方向用的是另外两条 keyframes（旧帧向右出、新帧从左进；实测 ${back.vtAnims[0]}）`);
  // 同一次切换里也不许凭空多出第二个过渡（连点、或者哪个子域自己又起一个）。
  ok(back.vtCalls === 1, 'E6b 同一次切换只有一个过渡（没有第二个模块偷偷再起一个）');

  /* ═════════ ⑤ 零动画的两条路（§2.9 末句）═════════
     反向验证：把 runShellTransition 里的 prefersReducedMotion() 判断去掉 → F1 当场红
     （calls 变 1、还能量到在跑的动画）；把 viewTransitionsSupported 去掉 → F3 红（当场抛异常）。 */
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp.evaluate('window.__vtReset()');
  await cdp.evaluate(`(document.querySelector('#lensSeg [data-lens="classic"]') || { click() {} }).click(), true`);
  const reduced = await cdp.evaluate(`(() => ({
    mode: document.documentElement.getAttribute('data-shell-mode'),
    vt: document.documentElement.dataset.vt || '',
    calls: window.__vt.calls,
    anims: document.getAnimations().filter(a => /^vt-/.test(String(a.animationName || ''))
      || String((a.effect && a.effect.pseudoElement) || '').includes('view-transition')).length,
    all: document.getAnimations().length,
  }))()`);
  ok(reduced.mode === 'classic' && reduced.calls === 0,
    `F1 prefers-reduced-motion: reduce → 【即时切换】：视角真的换了（${reduced.mode}），startViewTransition 一次没调（${reduced.calls}）`);
  ok(reduced.anims === 0 && reduced.vt === '',
    `F2 同一刻零视角切换动画（实测 ${reduced.anims} 条；页面总动画 ${reduced.all} 条 —— 头像呼吸那些与本条无关，所以只数 vt-*／view-transition 伪元素）`);
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  await sleep(200);
  // 第二条路：宿主【没有】startViewTransition（Safari 17 之前、Firefox 今天）。
  await cdp.evaluate('window.__vtSupported(false)');
  await cdp.evaluate('window.__vtReset()');
  await cdp.evaluate(`(document.querySelector('#lensSeg [data-lens="steward"]') || { click() {} }).click(), true`);
  const unsupported = await cdp.evaluate(`(() => ({
    mode: document.documentElement.getAttribute('data-shell-mode'),
    vt: document.documentElement.dataset.vt || '',
    anims: document.getAnimations().filter(a => /^vt-/.test(String(a.animationName || ''))
      || String((a.effect && a.effect.pseudoElement) || '').includes('view-transition')).length,
    rail: document.getElementById('sidebar').isSameNode(window.__k4.rail),
  }))()`);
  ok(unsupported.mode === 'steward' && unsupported.anims === 0 && unsupported.vt === '',
    `F3 宿主不支持 startViewTransition → 同样是零动画即时切换（视角 ${unsupported.mode}，动画 ${unsupported.anims} 条，不留 data-vt）`);
  ok(unsupported.rail === true, 'F4 这两条路上左栏也还是同一个节点（零动画不等于零功能）');
  await cdp.evaluate('window.__vtSupported(true)');

  /* ═════════ ⑥ 五组归组（§2.3）═════════
     反向验证：把 railGroupFor 的 needs_you 一支删掉 → G1 当场红（等你那一组不见了、A 落进别的组）。 */
  const grouped = await snap();
  const groupOf = sessionId => (grouped.groups.find(section => section.rows.includes(sessionId)) || {}).key || '';
  const stateOf = sessionId => (grouped.rowFacts.find(row => row.id === sessionId) || {}).state || '';
  console.log('NOTE 左栏实测：' + grouped.rowFacts.map(r => r.title + '=' + r.state + '@' + r.group).join(' ｜ '));
  // A 与 B 挂在同一件任务下，而【组是按任务分的】：聚合态 needs_you > done > running（06i
  // aggregateMissionState 一处算出），所以这一件整体落在「等你」—— 两条线程行跟着它一起。
  ok(groupOf(created.A) === 'needs_you' && stateOf(created.A) === 'needs_you',
    `G1 停在待决的 A：行上的态是 ${stateOf(created.A)}，它那一件落在 ${groupOf(created.A)} 组`);
  ok(groupOf(created.B) === groupOf(created.A) && stateOf(created.B) === 'running',
    `G2 同一件任务里在跑的 B 跟着那一件走（态 ${stateOf(created.B)}，组 ${groupOf(created.B)}）—— 组是按【任务】分的，不按线程`);
  ok(groupOf(created.C) === 'doneToday', `G3 今天跑完的 C 自成一件，落在「今天收工」（实测 ${groupOf(created.C)}）`);
  const keys = grouped.groups.map(section => section.key);
  const order = ['needs_you', 'running', 'queued', 'unfinished', 'doneToday', 'earlier'];   // 走查 #4：今天停下的单列「今天没做完」
  ok(keys.every((key, index) => order.indexOf(key) >= 0 && (index === 0 || order.indexOf(key) > order.indexOf(keys[index - 1]))),
    `G4 组的顺序就是 §2.3 那五组的顺序（空组不印；实测 ${keys.join(' → ')}）`);

  /* ═════════ ⑦ 「＋」两义（§2.3）═════════
     反向验证：把 startFromRail 里的视角判断删掉（永远 newSession）→ H1 红（管家视角也建出会话来了）。 */
  const countSessions = async () => {
    const response = await request(appPort, 'GET', '/api/sessions', null, token);
    return ((response && response.json && response.json.sessions) || []).length;
  };
  const beforePlus = await countSessions();
  const stewardPlus = await snap();
  ok(stewardPlus.plusLabel === zh['rail.newTask'],
    `H0 管家视角那枚「＋」说「${zh['rail.newTask']}」（实测「${stewardPlus.plusLabel}」）`);
  // 「点下去 → 目标切成另起一件 ＋ 焦点进输入框」这一串是【同步】的（startFromRail 派事件、
  // composer.markNewInMission 当场 renderChip + focus），所以点击与读数放在同一个表达式里：
  // 晚一拍读到的可能是右栏那一份抽屉的异步 openThread 抢走的焦点（它打开线程时会把焦点送到
  // 卡头标题 —— steward-drawer.js:1322，本刀不碰抽屉内部）。这一点也记进交付报告给 K6。
  const plusState = await cdp.evaluate(`(() => {
    document.getElementById('newSessionBtn').click();
    return {
      active: document.activeElement ? document.activeElement.id : '',
      target: (document.querySelector('#stewardTarget .steward-target-label') || { textContent: '' }).textContent.trim(),
    };
  })()`);
  await sleep(600);
  const afterPlus = await countSessions();
  ok(afterPlus === beforePlus,
    `H1 管家视角的「＋」【不建会话】（${beforePlus} → ${afterPlus}）—— 它只是把输入框的目标切成「另起一件」`);
  ok(plusState.target === zh['stewardShell.compose.targetNew'] && plusState.active === 'stewardComposerInput',
    `H2 目标 chip 说「${zh['stewardShell.compose.targetNew']}」、焦点落在输入框（实测 chip「${plusState.target}」／activeElement=${plusState.active}／输入框 disabled=${stewardPlus.composer.disabled}）`);
  await setLens('classic');
  const classicPlus = await snap();
  ok(classicPlus.plusLabel === zh['rail.newThread'],
    `H3 工作台视角同一枚钮改口说「${zh['rail.newThread']}」（实测「${classicPlus.plusLabel}」）`);
  await cdp.evaluate(`document.getElementById('newSessionBtn').click(), true`);
  // 「清空中栏现场」的可判定形式：新会话一条消息都没有（.message 是消息行的类，空态那张卡不是它）。
  const grew = await waitForEval(cdp, `(() => (document.querySelectorAll('#messages .message').length === 0
    && document.querySelectorAll('#messages .empty-state').length === 1
    && window.state && window.state.currentSession ? window.state.currentSession.id : null))()`);
  const afterClassicPlus = await countSessions();
  ok(afterClassicPlus === beforePlus + 1 && Boolean(grew),
    `H4 工作台视角的「＋」立刻建出一条线程并清空中栏现场（会话 ${beforePlus} → ${afterClassicPlus}，消息 0 条）`);
  await setLens('steward');

  /* ═════════ ⑧ 多线程任务 vs 单线程任务（§2.3）═════════
     反向验证：把 railTaskRow 那一支改成「总是画任务行」→ I2 红（C 上面多出一层没用的壳）。 */
  const shaped = await snap();
  const multi = shaped.groups.flatMap(section => section.tasks).find(task => task.threads >= 2);
  ok(Boolean(multi) && multi.threads === 2 && multi.count === '2' && multi.title.includes(MISSION_TITLE),
    `I1 A＋B 那一件是【一行任务行 ＋ 展开容器里两条线程行】（标题「${multi && multi.title}」，行上小计数 ${multi && multi.count}）`);
  const lone = shaped.groups.flatMap(section => section.loneRows);
  ok(lone.includes(created.C) && !lone.includes(created.A) && !lone.includes(created.B),
    'I2 单线程任务【不画任务层】：C 就是 .rail-tasks 的直系那一行，A／B 不是');
  ok(shaped.taskRows === 1, `I3 整个左栏只有那一行任务行（实测 ${shaped.taskRows} 行）`);

  /* ═════════ ⑨ 管家开线程 → 左栏 ≤1 s 出现（§6.3 指标 e）═════════
     反向验证：把 steward-board.js 里 EVENT_STREAM_ROW_EVENTS 的订阅去掉 → J2 红
     （行要等下一个 30 s 兜底拍才出现，实测 ∞）。 */
  const startedAt = Date.now();
  const dispatched = await request(appPort, 'POST', '/api/steward/act', {
    act: { kind: 'tool', tool: 'steward_thread_new', args: { title: NEW_THREAD, cwd: home, brief: { userText: '把这件事推进到底' } } },
  }, token);
  const newId = dispatched && dispatched.json && dispatched.json.result && dispatched.json.result.sessionId;
  const calledAt = Date.now();
  ok(Boolean(newId), `J1 管家开出线程（${newId || '失败'}）`);
  if (!newId) throw new Error('steward thread fixture unavailable');
  let seenAt = 0;
  for (let i = 0; i < 200 && !seenAt; i++) {
    const seen = await cdp.evaluate(`Boolean(document.querySelector('#railList .steward-board-thread[data-session-id="${newId}"]'))`);
    if (seen) { seenAt = Date.now(); break; }
    await sleep(25);
  }
  const lag = seenAt ? seenAt - calledAt : Infinity;
  ok(Boolean(seenAt) && lag <= NEW_ROW_BUDGET_MS,
    `J2 这一行 ${Number.isFinite(lag) ? lag : '∞'} ms 后出现在左栏 ≤${NEW_ROW_BUDGET_MS}（从调用返回起算；建线程本身用了 ${calledAt - startedAt} ms）`);
  const origin = await cdp.evaluate(`(() => {
    const row = document.querySelector('#railList .steward-board-thread[data-session-id="${newId}"]');
    const mark = row ? row.querySelector('.rail-origin') : null;
    return mark ? String(mark.dataset.origin || '') : '';
  })()`);
  ok(origin === 'steward', `J3 行上的来源标说这是「如意开的」（实测 ${origin}）`);

  /* ═════════ ⑩ §2.7 现场保持 ═════════
     反向验证：把 app-frame.js 的 restoreScroll() 摘掉 → K3 当场红（切回来滚到顶，实测 0）；
     把「两视角各记自己的选中」改成互相同步 → K4/K5 红。 */
  await setLens('classic');
  await cdp.evaluate(`(() => {
    const row = document.querySelector('#railList .steward-board-thread[data-session-id="${created.C}"] .steward-board-thread-title');
    if (row) row.click();
    return true;
  })()`);
  const loaded = await waitForEval(cdp, `(() => {
    const node = document.getElementById('messages');
    if (!node || !window.state.currentSession || window.state.currentSession.id !== '${created.C}') return null;
    return node.scrollHeight - node.clientHeight > 200 ? Math.round(node.scrollHeight) : null;
  })()`);
  ok(Boolean(loaded), `K1 工作台视角点左栏那一行＝在中栏打开它（C 的长回答撑出 ${loaded}px 的对话流）`);
  await cdp.evaluate(`(() => { const node = document.getElementById('messages'); node.scrollTop = 140; return true; })()`);
  await sleep(400);
  const scrolled = await snap();
  ok(scrolled.messagesScrollTop >= 130 && scrolled.sessionTitle.includes(THREAD_C),
    `K2 现场：对话流停在 ${scrolled.messagesScrollTop}px，线程头写着「${scrolled.sessionTitle}」`);
  await setLens('steward');
  await cdp.evaluate(`(() => {
    const row = document.querySelector('#railList .steward-board-thread[data-session-id="${created.A}"] .steward-board-thread-title');
    if (row) row.click();
    return true;
  })()`);
  const focused = await waitForEval(cdp, `(() => {
    const title = document.getElementById('stewardDrawerTitle');
    return title && title.textContent.includes(${JSON.stringify(THREAD_A)}) ? 1 : null;
  })()`);
  ok(Boolean(focused), 'K3 管家视角点左栏那一行＝换右栏焦点（中栏的对话流不动）');
  await setLens('classic');
  const restored = await waitForEval(cdp, `(() => {
    const node = document.getElementById('messages');
    return node && node.scrollTop >= 130 ? Math.round(node.scrollTop) : null;
  })()`, 100);
  ok(Boolean(restored),
    `K4 切回工作台：对话流【原样】停在 ${restored}px（display:none 会把 scrollTop 丢掉，这一条是 app-frame 的滚动位置保持在兜）`);
  const both = await snap();
  ok(both.sessionTitle.includes(THREAD_C) && both.selected.includes(created.C),
    `K5 工作台仍然选着 C（左栏那一行也还是选中态）—— 管家侧换焦点没有把它清掉`);
  await setLens('steward');
  // 107-Q1c：切离管家时焦点卡按设计收摊（steward-drawer.js 的 data-shell-mode 观察者 closeDrawer），
  // 切回来由 steward-board 的 syncNow 重开钉住的那一条 —— 重开先画「读取中…」，等那条会话的详情
  // 读回来才落闸（117k 的 loading 闸）。修前这里切完立刻拍快照，负载下取数慢一拍就撞上「读取中…」
  // （44 号文 §5 与 46 号文 Q1c 两次首跑红，签名一字不差；把 A 的会话详情请求拖慢 1.5 s 即两跑两红）。
  // 所以先等闸落下再判。等的是【闸】，不是「焦点对不对」：闸落后标题写的是哪条就判哪条，
  // 焦点被改写成 C 照样红（反向验证见 46 号文 Q1c 记录）。
  const gateStartedAt = Date.now();
  const gateDown = await waitForEval(cdp, `(() => {
    const title = document.getElementById('stewardDrawerTitle');
    const text = title ? title.textContent.trim() : '';
    return text && text !== ${JSON.stringify(zh['stewardShell.drawer.loading'])} ? 1 : null;
  })()`);
  const gateMs = gateDown ? Date.now() - gateStartedAt : Infinity;
  const stillFocus = await snap();
  ok(stillFocus.drawerTitle.includes(THREAD_A) && stillFocus.selected.includes(created.A),
    `K6 管家侧的焦点仍然是 A（实测焦点卡标题「${stillFocus.drawerTitle}」，左栏选中 ${stillFocus.selected.join('/')}；读取闸 ${Number.isFinite(gateMs) ? gateMs : '∞'} ms 后落下）—— 两个视角各记自己的现场，互不清空（§2.7 第三条）`);
  ok(stillFocus.activeInSteward === true,
    `K7 切换后焦点落在【这个视角里】：先由 applyShellMode 送到视角容器，再由管家侧自己接走（实测 activeElement=${stillFocus.activeId}）`);

  console.log(`SHOTS ${shots.wide1200} ${shots.narrow900}`);
} catch (error) {
  fail += 1;
  console.log('FAIL 未预期异常: ' + (error && error.message ? error.message : String(error)));
} finally {
  for (const res of openSockets) { try { res.end(); } catch { /* ignore */ } }
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  if (provider) { try { provider.close(); } catch { /* ignore */ } }
  try { stopRuyiTestBrowsers(profile); } catch { /* ignore */ }
}

console.log(`\nONE WORKBENCH FRAME BROWSER E2E: ${fail ? 'FAIL (' + fail + ')' : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
})();
