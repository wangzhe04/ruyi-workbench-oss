#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）

// 121 波 K5 真浏览器 E2E：工作台视角的【线程头】与【管家条】（34 号文 §2.5／§3／§4.4）。
//
// 这一件钉的是「一份数据一处控件」这句话能不能兑现（§2.1 第 10 条），八组事实，全部读 DOM、
// 计算样式与真端点，一个模块私有状态都不碰：
//   ① 工作台里 `.steward-chip` 恰一组（三枚：权限／模型／引擎），而 #modelChip／#permChip／
//      #permSelect／#stewardReturnBand 一个都不存在（§3.2 的删除清单，翻面钉）；
//   ② 切模型只改这条线程：整个过程 POST /api/config 【零请求】，PATCH /api/sessions/:id 恰一发；
//      菜单里那一项「设为新任务默认」点下去才 POST /api/config，恰【一】发（反向断言面）；
//   ③ 「任务 › 线程」面包屑只在多线程任务出现：A（挂在事项容器下、共两条线程）出，C（自成一件）不出；
//   ④ 管家条三态（§2.5／§4.5）：没盯 → 「看得见、不插手」；盯着且你正坐着 → 「你坐着时它不动手」；
//      盯着但你不在这条线程上（切到管家视角，在场信号随之变）→ 「盯着这条」；
//   ⑤ 那枚开关真的写进去了：PATCH 之后 /api/missions 行上的 watched 翻面（服务端事实，不是界面自说）；
//   ⑥ 用户手按的停止进决策日志（§4.4 末条／33 号文 §0 的不对称）：点「它正在跑」卡上的停止 →
//      /api/steward/decisions 多出一行 tool='user_stop'；
//   ⑦ 线程头在 1200／1600／1920 三档【都是两行】、高度逐档相同（§13.7 登记①「1200 宽折行」关闭），
//      三档各存一张图；
//   ⑧ 「在工作台打开」与「切回管家」是同一条线程：焦点栏的那一枚把工作台切到这条线程，
//      顶栏分段钮切回管家时焦点落回它（退役的 steward-classic-window.js 里 backToSteward 的后半）。
//
// 夹具：事项容器 M 下挂 A（停在 question 待决）与 B（回合一直挂着，⑥ 要它在跑）；C 自成一件。
// 与 one-workbench-frame.browser.e2e.js 同一套 CDP 无头驱动与 fake provider；后端零改动。
//
// 截图落点：默认在夹具临时目录，设了 RUYI_SHOT_DIR 就落到那里（交付报告要贴这三张）。
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

const THREAD_A = '等华南的表';       // 停在 question 待决
const THREAD_B = '跑批处理';         // 回合一直挂着（⑥ 的停止对象）
const THREAD_C = '选个框架';         // 自成一件（③ 的单线程任务）
const MISSION_TITLE = '季度收尾';    // A＋B 的事项容器（多线程任务）
const POLL_MS = 120000;              // 兜底节拍拉满：本件不测节拍

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

// 确定性 provider（与 K4 那一件同一份）：'ask' → 一条 request_user_input；'hang' → 只开流不收尾；
// 其余 → 一段短回答。判据按【整份请求体里的标记】认，不按「最后一条 user 消息」认。
const openSockets = [];
async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"},{"id":"fake-model-2"}]}');
    }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const intent = raw.includes('hang here') ? 'hang' : (raw.includes('ask about south') ? 'ask' : 'short');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = payload => res.write('data: ' + JSON.stringify(payload) + '\n\n');
    if (intent === 'ask') {
      const args = JSON.stringify({ questions: [{
        id: 'south', header: 'South', question: '华南那张表要等吗？', answerMode: 'single',
        options: [{ id: 'wait', label: '等' }, { id: 'skip', label: '不等' }],
      }] });
      frame({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_k5_q', type: 'function', function: { name: 'request_user_input', arguments: '' } }] }, finish_reason: null }] });
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (intent === 'hang') {
      openSockets.push(res);
      frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '在跑…' }, finish_reason: null }] });
      return;   // 刻意不收尾：这一条永远「在跑」
    }
    frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '好的，记下了。' }, finish_reason: null }] });
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

// 预算 800 × 40ms = 32 s（与同族五件同一个数：并行全量下四个无头浏览器抢 CPU）。
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

// 就绪判据与 K4 那一件同款（真 config 到达；K0 的时序是 bind 期先 fail-closed 落 classic），
// 外加线程头那一组 chip 真的挂上来了（js/thread-head.js 的 bindThreadHead 在 boot 末尾跑）。
const READY = `(() => {
  if (!window.state || !window.state.status || !window.state.config || !window.state.config.configSchema) return null;
  if (!document.getElementById('railList') || !document.getElementById('threadHead')) return null;
  if (!document.querySelector('#threadChips [data-chip="engine"]')) return null;
  return { ready: true };
})()`;

const rectExpr = `node => { if (!node) return null; const b = node.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) }; }`;

// 线程头快照：只读 DOM、公开属性与计算样式。
const HEAD = `(() => {
  const rect = ${rectExpr};
  const byId = id => document.getElementById(id);
  const head = byId('threadHead');
  const mission = byId('threadMission');
  const band = byId('threadStewardBand');
  const toggle = byId('threadStewardWatch');
  return {
    mode: document.documentElement.getAttribute('data-shell-mode'),
    cw: document.documentElement.clientWidth,
    head: rect(head),
    hue: head ? (head.dataset.threadHue || '') : '',
    rowMain: rect(document.querySelector('#threadHead .th-row-main')),
    rowConfig: rect(document.querySelector('#threadHead .th-row-config')),
    // 一组 chip = 三枚（权限／模型／引擎）。分两处数：线程头里的、以及【整个工作台视角里】的 ——
    // 后者才是「一份数据一处控件」那条纪律的判据面。
    chipsInHead: document.querySelectorAll('#threadChips .steward-chip').length,
    chipKindsInHead: [...document.querySelectorAll('#threadChips [data-chip]')].map(n => n.dataset.chip),
    // 「不折」这件事要按【三枚 chip 真的画在哪儿】量：§13.7 登记①说的正是「引擎 chip 与打印钮
    // 掉到第二行」。y 相同 ＝ 三枚在同一行上；右边界收在配置行里 ＝ 没有被挤出去。
    chipRects: [...document.querySelectorAll('#threadChips .steward-chip')].map(rect),
    chipHostsInWorkbench: document.querySelectorAll('.app-shell .steward-chips, .app-shell .steward-drawer-chips').length,
    chipsInWorkbench: document.querySelectorAll('.app-shell .steward-chip').length,
    // §3.2 的删除清单：翻面钉「它们真的不在了」。
    retired: ['modelChip', 'permChip', 'permSelect', 'permSelectHost', 'stewardReturnBand', 'stewardReturnChips']
      .filter(id => Boolean(byId(id))),
    sessionTitle: (byId('sessionTitle') || {}).textContent || '',
    missionText: mission ? mission.textContent : '',
    missionHidden: mission ? mission.hidden : null,
    stateText: (byId('threadState') || {}).textContent || '',
    originTitle: byId('threadOrigin') ? (byId('threadOrigin').title || '') : '',
    bandHidden: band ? band.hidden : null,
    bandText: (byId('threadStewardText') || {}).textContent || '',
    bandWatched: band ? (band.dataset.watched || '') : '',
    toggleChecked: toggle ? toggle.checked : null,
    avatarStates: [...document.querySelectorAll('#threadStewardAvatar .sa-ring')].length,
    conn: (byId('statusLine') || {}).textContent || '',
    connTone: byId('statusLine') ? (byId('statusLine').dataset.tone || '') : '',
    connTitle: byId('statusLine') ? (byId('statusLine').title || '') : '',
    posts: window.__k5 ? window.__k5.posts.slice() : [],
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-thread-head-'));
const home = path.join(root, 'home');
const workA = path.join(root, 'work-a');
const workB = path.join(root, 'work-b');
const workC = path.join(root, 'work-c');
const profile = path.join(root, 'profile');
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
    models: [{ id: 'fake-model', label: 'Fake' }, { id: 'fake-model-2', label: 'Fake 2' }],
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
    title: MISSION_TITLE, acceptance: [{ text: '汇总表交付', done: true }],
  }, token);
  const missionId = container && container.json && container.json.mission && container.json.mission.missionId;
  ok(Boolean(missionId), `A4 事项容器已建（${missionId || '失败'}）`);
  for (const id of [created.A, created.B]) {
    await request(appPort, 'POST', `/api/missions/${encodeURIComponent(missionId)}/threads`, { action: 'attach', sessionId: id }, token);
  }
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === created.A);
    return Boolean(row && String(row.missionTitle || '') === MISSION_TITLE && Number(row.threadCount) > 1);
  }, token)), 'A5 A 已挂进事项容器，行上 missionTitle 与 threadCount>1 都到位（③ 的面包屑判据就读这两样）');

  // C 先跑完一句；A 停在待决；B 一直挂着（⑥ 要停的就是它）。
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
  }, token)), 'A7 线程 B 的回合一直在飞（⑥ 要停的就是它）');

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

  // ② 的探针：包住 window.fetch 数【写请求】。必须在页面脚本之前装（addScriptToEvaluateOnNewDocument
  // ＋ reload）—— 晚一步就包不住 boot 那一批。这是「包住宿主 API 数事实」的既有手法
  // （one-workbench-frame.browser 数 startViewTransition、steward-board.e2e 数 setInterval 都是它）。
  // 只记方法与路径，不碰 body、不改行为（原样转调 native fetch）。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const native = window.fetch.bind(window);
      window.__k5 = { posts: [] };
      window.__k5Reset = () => { window.__k5.posts.length = 0; return true; };
      window.fetch = (input, init) => {
        try {
          const url = String(typeof input === 'string' ? input : (input && input.url) || '');
          const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
          if (method !== 'GET') window.__k5.posts.push(method + ' ' + url.replace(/^https?:\\/\\/[^/]+/, '').split('?')[0]);
        } catch { /* 记账失败不该影响请求本身 */ }
        return native(input, init);
      };
    })();`,
  });
  await cdp.evaluate('location.reload(); true');
  ok(Boolean(await waitForEval(cdp, READY)), 'A10 首屏就绪（config 真到达、线程头与那组 chip 已挂上）');

  const setLens = async lens => {
    await cdp.evaluate(`(document.querySelector('#lensSeg [data-lens="${lens}"]') || { click() {} }).click(), true`);
    return waitForEval(cdp, `(() => document.documentElement.getAttribute('data-shell-mode') === '${lens}'
      && !document.documentElement.dataset.vt ? 1 : null)()`);
  };
  const openInWorkbench = async sessionId => {
    await cdp.evaluate(`(() => {
      const row = document.querySelector('#railList .steward-board-thread[data-session-id="${sessionId}"] .steward-board-thread-title');
      if (row) row.click();
      return true;
    })()`);
    return waitForEval(cdp, `(() => (window.state && window.state.currentSession && window.state.currentSession.id === '${sessionId}') ? 1 : null)()`);
  };
  const snap = () => cdp.evaluate(HEAD);

  await waitForEval(cdp, `(() => document.querySelectorAll('#railList .steward-board-thread').length >= 3 ? 1 : null)()`);
  await setLens('classic');
  ok(Boolean(await openInWorkbench(created.C)), 'A11 左栏点 C 那一行 → 工作台中栏换成这条线程（§2.3 点击语义）');

  /* ═════════ ① 一套 chip、零残留（§2.5／§3.1／§3.2）═════════
     反向验证：把 index.html 里 #modelChip 那一段加回顶栏 → B2 当场红。 */
  const one = await snap();
  ok(one.chipsInHead === 3 && JSON.stringify(one.chipKindsInHead) === JSON.stringify(['permission', 'model', 'engine']),
    `B1 线程头恰有一组 chip＝三枚（权限／模型／引擎，实测 ${JSON.stringify(one.chipKindsInHead)}）`);
  ok(one.chipHostsInWorkbench === 1 && one.chipsInWorkbench === 3,
    `B1b 整个工作台视角里只有这一个 chip 宿主、只有这三枚 chip（实测宿主 ${one.chipHostsInWorkbench} 个 / chip ${one.chipsInWorkbench} 枚）`);
  ok(one.retired.length === 0,
    `B2 #modelChip／#permChip／#permSelect／#permSelectHost／#stewardReturnBand 一个都不在（实测复活：${one.retired.join('、') || '无'}）`);
  // 「两行」的判据不能只写 `第二行的 y 比第一行大`：把 flex-direction 改回 row 之后两行会并排，
  // 而 align-items:center 让矮的那一行恰好低 2px —— 那条判据照样成立（第一轮实测：整件 ALL PASS，
  // 门是画上去的）。真正的两行 ＝ 【同一个左边界 ＋ 第二行整个落在第一行下面 ＋ 头高装得下两行】。
  ok(one.rowMain && one.rowConfig
    && one.rowConfig.x === one.rowMain.x
    && one.rowConfig.y >= one.rowMain.bottom
    && one.head.h >= one.rowMain.h + one.rowConfig.h,
    `B3 线程头是两行结构：第一行「这是哪条线程」x=${one.rowMain && one.rowMain.x}/y=${one.rowMain && one.rowMain.y}/bottom=${one.rowMain && one.rowMain.bottom}，第二行「这条线程怎么跑」x=${one.rowConfig && one.rowConfig.x}/y=${one.rowConfig && one.rowConfig.y}，头高 ${one.head && one.head.h}`);
  ok(Boolean(one.conn) && one.connTone === 'ok' && /fake|Fake/.test(one.connTitle),
    `B4 连接态落在线程头第二行那个真看得见的位置（§13.7 登记⑦）：可见文字「${one.conn}」不含模型名，服务商 · 模型只进 title「${one.connTitle}」`);

  /* ═════════ ② 切模型只改这条线程（§3.1 的要害）═════════
     修前 2.0 顶栏切一次模型会【顺带】POST /api/config 改全局默认（33 号文 §0 记的那笔账）。
     反向验证：把 steward-chips.js 的 patchSession 改成也写 /api/config → C1 当场红。 */
  await cdp.evaluate('window.__k5Reset(), true');
  await cdp.evaluate(`document.querySelector('#threadChips [data-chip="model"]').click(), true`);
  ok(Boolean(await waitForEval(cdp, `!!document.querySelector('#threadChips [data-model-id="fake-model-2"]')`)),
    'C0 模型菜单开得出来，候选来自这条线程生效的那个端点');
  await cdp.evaluate(`document.querySelector('#threadChips [data-model-id="fake-model-2"]').click(), true`);
  ok(Boolean(await waitForHttp(appPort, 'GET', `/api/sessions/${created.C}`, result => {
    const route = result.json && result.json.session && result.json.session.engineRoute;
    return Boolean(route && route.model === 'fake-model-2');
  }, token)), 'C1 切模型真的落到这条线程（PATCH /api/sessions/:id 那一个写口）');
  const afterSwitch = await snap();
  const configPosts = afterSwitch.posts.filter(line => line.endsWith('/api/config'));
  const sessionPatches = afterSwitch.posts.filter(line => line.startsWith('PATCH /api/sessions/'));
  ok(configPosts.length === 0 && sessionPatches.length === 1,
    `C2 切模型【零】/api/config 请求、恰一发 PATCH /api/sessions/:id（实测写请求 ${JSON.stringify(afterSwitch.posts)}）`);
  // 反向面：菜单里那一项显式的「设为新任务默认」才写全局。
  await cdp.evaluate('window.__k5Reset(), true');
  await cdp.evaluate(`document.querySelector('#threadChips [data-chip="model"]').click(), true`);
  ok(Boolean(await waitForEval(cdp, `!!document.querySelector('#threadChips [data-chip-action="setDefault"]')`)),
    `C3 模型菜单里有显式的「${zh['stewardShell.chips.setAsDefault']}」这一项`);
  await cdp.evaluate(`document.querySelector('#threadChips [data-chip-action="setDefault"]').click(), true`);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/status', result => {
    const providers = (result.json && result.json.config && result.json.config.providers) || [];
    return providers.some(item => item && item.id === 'fake' && item.model === 'fake-model-2');
  }, token)), 'C4 「设为新任务默认」真的写进了全局默认（POST /api/config）');
  const afterDefault = await snap();
  ok(afterDefault.posts.filter(line => line.endsWith('/api/config')).length === 1,
    `C5 而且恰【一】发 /api/config（实测写请求 ${JSON.stringify(afterDefault.posts)}）—— 默认从「隐式顺带」变成「显式一项」`);
  // 尾部那三件 2.0 弹层独有的事也在（§3.1：强度／刷新／管理服务商…）。
  await cdp.evaluate(`document.querySelector('#threadChips [data-chip="model"]').click(), true`);
  const tail = await waitForEval(cdp, `(() => {
    const menu = document.querySelector('#threadChips [data-kind="model"]');
    if (!menu || menu.hidden) return null;
    return {
      effort: Boolean(menu.querySelector('.mc-effort-select')),
      refresh: Boolean(menu.querySelector('[data-chip-action="refreshModels"]')),
      manage: Boolean(menu.querySelector('[data-chip-action="manageProviders"]')),
    };
  })()`);
  ok(tail && tail.effort && tail.refresh && tail.manage,
    `C6 2.0 弹层独有的三件事都搬进了菜单尾部（强度 ${tail && tail.effort}／刷新 ${tail && tail.refresh}／管理服务商 ${tail && tail.manage}）`);
  await cdp.evaluate(`document.body.click(), true`);

  /* ═════════ ③ 「任务 › 线程」只在多线程任务出现（§2.5）═════════ */
  const atC = await snap();
  ok(atC.missionHidden === true && atC.missionText === '',
    `D1 C 自成一件（单线程任务）→ 面包屑不出（实测 hidden=${atC.missionHidden}、文本「${atC.missionText}」）`);
  ok(Boolean(await openInWorkbench(created.A)), 'D2 换到 A（挂在事项容器下、同容器两条线程）');
  const atA = await waitForEval(cdp, `(() => {
    const node = document.getElementById('threadMission');
    return node && node.hidden === false && node.textContent ? { text: node.textContent } : null;
  })()`);
  ok(atA && atA.text === MISSION_TITLE,
    `D3 A 是多线程任务 → 面包屑出「${atA && atA.text}」（＝事项容器名，读的是索引行上的 missionTitle／threadCount）`);
  const headA = await snap();
  ok(Boolean(headA.hue) && Boolean(headA.stateText),
    `D4 线程头带着色条色号（hue=${headA.hue}）与五态药丸（「${headA.stateText}」）—— 色说身份、药丸说状态（F1 纪律）`);

  /* ═════════ ④⑤ 管家条三态与那枚开关（§2.5／§4.4／§4.5）═════════
     反向验证：把 thread-head.js 的 stewardBandKey 里 seated 那一支拿掉 → E3 当场红。 */
  ok(headA.bandHidden === false && headA.avatarStates === 1,
    'E0 管家条在，且小 avatar 与管家壳那张脸同源（同一套 sa-* 类名，本件只数环画出来了没有）');
  // 「没盯」那一态要拿一条【自成一件】的线程来量：A 挂进了事项容器，按 K3 的判据
  // （06i stewardWatchedThread 第三条 missionId !== sessionId）它本来就是 watched ——
  // 归并过的线程管家当然要动手。C 自成一件，才是「你自己在工作台开的那种」。
  ok(headA.bandWatched === '1' && headA.toggleChecked === true,
    `E1a 归并进事项容器的线程天然就在管家的视野里（K3 §4.1 的判据，界面只读它：watched=${headA.bandWatched}）`);
  ok(Boolean(await openInWorkbench(created.C)), 'E1b 换到 C（自成一件，没人交给管家盯）');
  const headC = await snap();
  ok(headC.bandText === zh['threadHead.steward.seeing'] && headC.toggleChecked === false && headC.bandWatched === '0',
    `E1 没盯：「${headC.bandText}」（§2.1 第 12 条「看得见 ≠ 插手」）`);
  await cdp.evaluate(`document.getElementById('threadStewardWatch').click(), true`);
  const watchedRow = await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === created.C);
    return Boolean(row && row.watched === true);
  }, token);
  ok(Boolean(watchedRow), 'E2 那枚开关写的是 PATCH /api/sessions/:id {stewardWatch:true} —— /api/missions 行上 C 的 watched 翻面（服务端事实，不是界面自说）');
  const seated = await waitForEval(cdp, `(() => {
    const node = document.getElementById('threadStewardText');
    return node && node.textContent === ${JSON.stringify(zh['threadHead.steward.watchingSeated'])} ? { text: node.textContent } : null;
  })()`);
  ok(Boolean(seated),
    `E3 盯着 ＋ 你正坐在这条线程上 → 「${zh['threadHead.steward.watchingSeated']}」（§4.5：你坐着时它不动手）`);
  // 第三态：切到管家视角 —— 在场信号随之变成 lens=steward（事件流重连即在场信号的唯一写口），
  // 索引行上的 seatedBy 掉回 null。点一下左栏那一行让行重取一发（焦点事件那一刷，
  // steward-board.static K2 钉着它真的存在），不必等 30 s 的兜底节拍。
  await setLens('steward');
  // 先等【服务端事实】翻面：换视角之后事件流去抖 300 ms 重连，而重连就是在场信号的唯一写口
  // （K2b §6.2）。13e 的 seatedBy 每次请求现算，所以行上这一格一变就说明在场真的改了。
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === created.C);
    return Boolean(row) && row.watched === true && !row.seatedBy;
  }, token)), 'E4a 切到管家视角之后，索引行上的 seatedBy 掉回空（在场信号随视角走，§4.3）');
  // 再让左栏重取一发行：管家条画的是【索引行】，产品里让它重取的口就是那枚开关自己
  // （thread-head.js 的 refreshRows）。关一下再开一下＝两发真 PATCH ＋ 两次重取，
  // 不借任何测试专用钩子。
  const toggleWatch = async want => {
    await cdp.evaluate(`document.getElementById('threadStewardWatch').click(), true`);
    return waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
      const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === created.C);
      return Boolean(row) && row.watched === want;
    }, token);
  };
  ok(Boolean(await toggleWatch(false)), 'E4b 「别盯了」写回 false（开关是双向的，用户随时能收回来）');
  ok(Boolean(await toggleWatch(true)), 'E4c 再交给它盯一次（这一发重取带回来的行上 seatedBy 是空的）');
  const notSeated = await waitForEval(cdp, `(() => {
    const node = document.getElementById('threadStewardText');
    return node && node.textContent === ${JSON.stringify(zh['threadHead.steward.watching'])} ? { text: node.textContent } : null;
  })()`, 400);
  ok(Boolean(notSeated),
    `E4 盯着 ＋ 你不在这条线程上（切到管家视角，在场信号随之变）→ 「${zh['threadHead.steward.watching']}」`);
  await setLens('classic');

  /* ═════════ ⑧ 分段钮是视角开关，不是「回到管家（看这条）」（§2.1 第 11 条／§2.7 第三条）═════════
     K5 第一版在这里照 §2.7 第一条把退役的 backToSteward 后半搬到分段钮上（切回管家就派
     steward:focus-thread 到工作台此刻那条线程），全量被 K4 的 one-workbench-frame K6 逮到：
     两个视角各记自己的现场，切换不改对方的焦点。§2.7 第一条说的是那枚已退役按钮的语义。
     这里钉的是同一条事实的工作台侧：先在管家视角把焦点钉到 A，去工作台打开 C，再切回来，
     焦点仍是 A、不是 C。返回带的 sessionStorage 标记也没了（F3）。
     反向验证：在 app-frame.js 的 setLens 里切回 steward 时派一发 steward:focus-thread
     （detail 用工作台当前线程）→ F2 当场红。 */
  await setLens('steward');
  await cdp.evaluate(`(() => { document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: ${JSON.stringify(created.A)} } })); return true; })()`);
  const pinnedA = await waitForEval(cdp, `(() => {
    const node = document.getElementById('stewardDrawerTitle');
    return node && node.textContent && node.textContent.includes(${JSON.stringify(THREAD_A)}) ? { title: node.textContent } : null;
  })()`);
  ok(Boolean(pinnedA), `F0a 管家视角先把焦点钉到 A（实测焦点卡标题「${pinnedA && pinnedA.title}」）`);
  await setLens('classic');   // 先到工作台再点行：管家视角里点左栏那一行＝换焦点（§2.3 点击语义），那就不是本条要考的事了
  ok(Boolean(await openInWorkbench(created.C)), 'F0b 去工作台打开 C');
  await setLens('steward');
  await sleep(600);   // 切换动效与任何可能的错误派发都落地之后再读（这里要证的是【没有】变化）
  const focusKept = await cdp.evaluate(`(() => {
    const node = document.getElementById('stewardDrawerTitle');
    return { title: node ? String(node.textContent || '') : '' };
  })()`);
  ok(focusKept.title.includes(THREAD_A) && !focusKept.title.includes(THREAD_C),
    `F2 顶栏分段钮切回管家 → 焦点【原样】还是 A，不被工作台此刻的 C 改写（实测焦点卡标题「${focusKept.title}」；§2.1 第 11 条）`);
  const noMark = await cdp.evaluate(`(() => { try { return sessionStorage.getItem('wcw.stewardReturn'); } catch { return 'ERR'; } })()`);
  ok(noMark === null, `F3 没有任何返回标记了（117g 的 sessionStorage 那一支随返回带整段退役；实测 ${JSON.stringify(noMark)}）`);
  await setLens('classic');

  /* ═════════ ⑥ 用户手按的停止进决策日志（§4.4 末条／33 号文 §0）═════════
     反向验证：把 13-http-router.js 里那一下 StewardHooks.appendUserStop 摘掉 → G2 当场红。 */
  const beforeStop = await request(appPort, 'GET', '/api/steward/decisions?limit=200', null, token);
  const beforeRows = ((beforeStop && beforeStop.json && beforeStop.json.rows) || []).filter(row => row && row.tool === 'user_stop');
  ok(beforeRows.length === 0, `G0 停之前决策日志里没有 user_stop（实测 ${beforeRows.length} 行）`);
  ok(Boolean(await openInWorkbench(created.B)), 'G1 工作台换到 B（它的回合一直在飞，而且是【别处】起的那种）');
  const stopped = await waitForEval(cdp, `(() => {
    const button = document.querySelector('.live-turn-stop');
    if (!button) return null;
    button.click();
    return 1;
  })()`);
  ok(Boolean(stopped), 'G1b 「它正在跑」卡上那枚停止键在（117m-A5：别处起的回合，用户手按的停止就是这一枚）');
  const afterStop = await waitForHttp(appPort, 'GET', '/api/steward/decisions?limit=200', result => {
    const rows = ((result.json && result.json.rows) || []).filter(row => row && row.tool === 'user_stop');
    return rows.length === 1 && rows[0].targetSessionId === created.B;
  }, token);
  ok(Boolean(afterStop), 'G2 用户手按的停止在决策日志上多了一行 user_stop，且指着 B（33 号文 §0 那条不对称还清了）');
  const stopRow = afterStop && ((afterStop.json && afterStop.json.rows) || []).find(row => row && row.tool === 'user_stop');
  ok(stopRow && stopRow.mayAct === 'user' && stopRow.basis && stopRow.basis.origin === 'ui_stop'
    && stopRow.undoRef && stopRow.undoRef.kind === 'none',
    `G3 行形状与 steward_thread_stop 那一条对齐：mayAct=${stopRow && stopRow.mayAct}、basis.origin=${stopRow && stopRow.basis && stopRow.basis.origin}、undoRef.kind=${stopRow && stopRow.undoRef && stopRow.undoRef.kind}`);

  /* ═════════ ⑦ 1200／1600／1920 三档都是两行、不折（§13.7 登记①）═════════
     反向验证：把 chat-shell.css 的 .topbar.thread-head 改回 flex-direction:row → H1 当场红
     （1200 那一档会折成三行，高度当场跳）。 */
  await cdp.evaluate(`(() => { const row = document.querySelector('#railList .steward-board-thread[data-session-id="${created.A}"] .steward-board-thread-title'); if (row) row.click(); return true; })()`);
  await waitForEval(cdp, `(() => (window.state && window.state.currentSession && window.state.currentSession.id === '${created.A}') ? 1 : null)()`);
  const resize = async (width, height) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
  };
  const heights = {};
  for (const width of [1200, 1600, 1920]) {
    await resize(width, 900);
    const at = await snap();
    heights[width] = at.head ? at.head.h : -1;
    ok(at.rowMain && at.rowConfig
      && at.rowConfig.x === at.rowMain.x
      && at.rowConfig.y >= at.rowMain.bottom
      && at.rowConfig.bottom <= at.head.bottom,
      `H1@${width} 线程头仍是【两行】：两行同一个左边界 x=${at.rowMain && at.rowMain.x}，第二行整个落在第一行下面（y=${at.rowConfig && at.rowConfig.y} ≥ bottom=${at.rowMain && at.rowMain.bottom}）且收在头里（${at.rowConfig && at.rowConfig.bottom} ≤ ${at.head && at.head.bottom}）`);
    // §13.7 登记①那条债的正身：三枚 chip 有没有被挤得折到第二行去。按【它们真的画在哪儿】量。
    const chipYs = [...new Set((at.chipRects || []).map(box => box && box.y))];
    const chipOverflow = (at.chipRects || []).some(box => box && at.rowConfig && box.x + box.w > at.rowConfig.x + at.rowConfig.w + 1);
    ok(at.chipsInHead === 3 && at.retired.length === 0 && chipYs.length === 1 && !chipOverflow,
      `H2@${width} 三枚 chip 一枚不少、都在同一行上（y=${chipYs.join('/')}）、没被挤出配置行，退役那五个一个没回来`);
    shots[width] = path.join(shotDir, `k5-thread-head-${width}.png`);
    fs.writeFileSync(shots[width], Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    ok(fs.statSync(shots[width]).size > 8000, `H3@${width} 截图已存（${shots[width]}）`);
  }
  ok(heights[1200] === heights[1600] && heights[1600] === heights[1920] && heights[1200] > 0,
    `H4 三档高度逐字相同（${heights[1200]} / ${heights[1600]} / ${heights[1920]} px）—— §13.7 登记①那条「1200 宽折行」到此关闭`);

  console.log(`SHOTS ${shots[1200]} ${shots[1600]} ${shots[1920]}`);
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

console.log(`\nWORKBENCH THREAD HEAD BROWSER E2E: ${fail ? 'FAIL (' + fail + ')' : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
})();
